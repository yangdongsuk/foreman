// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Tollgate: prepaid stablecoin payment channels for pay-per-call APIs and AI agents on Arc
/// @notice A payer locks USDC (or EURC) in a channel for one provider. Each API call is paid with an
///         off-chain voucher: an EIP-712 signature over the *cumulative* amount owed so far. The
///         provider redeems the latest voucher whenever it likes, so thousands of calls settle in a
///         handful of transactions. Vouchers are signed by a dedicated `signer` key, so an agent can
///         be handed a session key whose worst-case loss is the channel balance, never the wallet.
///         Closing is two-step: the payer requests it, the provider has `grace` seconds to redeem
///         the last voucher, then the payer takes back the rest. No owner, no fees.
contract Tollgate {
    struct Channel {
        address payer;
        address provider;
        address signer; // key that signs vouchers (payer's wallet or a session key)
        IERC20 token;
        uint128 deposit; // total ever deposited
        uint128 redeemed; // cumulative amount paid to the provider
        uint64 grace; // seconds the provider has to redeem after a close request
        uint64 closeRequestedAt; // 0 while open
        bool closed;
    }

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint64 public constant MIN_GRACE = 10 minutes;
    uint64 public constant MAX_GRACE = 7 days;

    bytes32 private immutable _domainSeparator;
    uint256 private immutable _chainId;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public nonces;

    uint256 private _locked = 1;

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed payer,
        address indexed provider,
        address signer,
        address token,
        uint256 deposit,
        uint64 grace
    );
    event ToppedUp(bytes32 indexed channelId, uint256 amount, uint256 deposit);
    event Redeemed(bytes32 indexed channelId, uint256 cumulativeAmount, uint256 paid);
    event CloseRequested(bytes32 indexed channelId, uint256 closableAt);
    event Closed(bytes32 indexed channelId, uint256 toProvider, uint256 refunded);

    error InvalidParams();
    error NotPayer();
    error NotProvider();
    error ChannelClosed();
    error BadSignature();
    error NotIncreasing();
    error ExceedsDeposit();
    error TooEarly();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor() {
        _chainId = block.chainid;
        _domainSeparator = _buildDomainSeparator();
    }

    // ------------------------------------------------------------------ payer

    /// @notice Open a channel to `provider` and fund it. Vouchers must be signed by `signer`.
    function open(address provider, address signer, IERC20 token, uint128 amount, uint64 grace)
        external
        nonReentrant
        returns (bytes32 channelId)
    {
        if (
            provider == address(0) || provider == msg.sender || signer == address(0) || address(token) == address(0)
                || amount == 0 || grace < MIN_GRACE || grace > MAX_GRACE
        ) revert InvalidParams();

        channelId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonces[msg.sender]++));
        channels[channelId] = Channel({
            payer: msg.sender,
            provider: provider,
            signer: signer,
            token: token,
            deposit: amount,
            redeemed: 0,
            grace: grace,
            closeRequestedAt: 0,
            closed: false
        });
        emit ChannelOpened(channelId, msg.sender, provider, signer, address(token), amount, grace);
        _pull(token, amount);
    }

    /// @notice Add funds to an open channel. Cancels a pending close request.
    function topUp(bytes32 channelId, uint128 amount) external nonReentrant {
        Channel storage c = channels[channelId];
        if (msg.sender != c.payer) revert NotPayer();
        if (c.closed) revert ChannelClosed();
        if (amount == 0) revert InvalidParams();
        c.deposit += amount;
        c.closeRequestedAt = 0;
        emit ToppedUp(channelId, amount, c.deposit);
        _pull(c.token, amount);
    }

    /// @notice Start closing. The provider has `grace` seconds to redeem its latest voucher.
    function requestClose(bytes32 channelId) external {
        Channel storage c = channels[channelId];
        if (msg.sender != c.payer) revert NotPayer();
        if (c.closed) revert ChannelClosed();
        c.closeRequestedAt = uint64(block.timestamp);
        emit CloseRequested(channelId, block.timestamp + c.grace);
    }

    /// @notice Finish closing after the grace period and take back whatever was not redeemed.
    function finalizeClose(bytes32 channelId) external nonReentrant {
        Channel storage c = channels[channelId];
        if (msg.sender != c.payer) revert NotPayer();
        if (c.closed) revert ChannelClosed();
        if (c.closeRequestedAt == 0 || block.timestamp < uint256(c.closeRequestedAt) + c.grace) revert TooEarly();
        _close(channelId, c, 0);
    }

    // --------------------------------------------------------------- provider

    /// @notice Collect everything owed up to `cumulativeAmount`. Anyone may submit a voucher;
    ///         the money always goes to the provider.
    function redeem(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.closed || c.payer == address(0)) revert ChannelClosed();
        uint256 paid = _settleVoucher(channelId, c, cumulativeAmount, signature);
        emit Redeemed(channelId, cumulativeAmount, paid);
        _push(c.token, c.provider, paid);
    }

    /// @notice Cooperative close by the provider: optionally redeem a final voucher, refund the
    ///         rest to the payer immediately. Pass an empty signature to close without redeeming.
    function closeByProvider(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature)
        external
        nonReentrant
    {
        Channel storage c = channels[channelId];
        if (msg.sender != c.provider) revert NotProvider();
        if (c.closed) revert ChannelClosed();
        uint256 paid = signature.length == 0 ? 0 : _settleVoucher(channelId, c, cumulativeAmount, signature);
        _close(channelId, c, paid);
    }

    // ------------------------------------------------------------------ views

    /// @notice EIP-712 digest a signer must sign for a voucher.
    function voucherDigest(bytes32 channelId, uint256 cumulativeAmount) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator(), keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount))
            )
        );
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _chainId ? _domainSeparator : _buildDomainSeparator();
    }

    /// @notice Amount still available for vouchers.
    function available(bytes32 channelId) external view returns (uint256) {
        Channel storage c = channels[channelId];
        return c.closed ? 0 : c.deposit - c.redeemed;
    }

    // --------------------------------------------------------------- internal

    function _settleVoucher(bytes32 channelId, Channel storage c, uint256 cumulativeAmount, bytes calldata signature)
        internal
        returns (uint256 paid)
    {
        if (cumulativeAmount <= c.redeemed) revert NotIncreasing();
        if (cumulativeAmount > c.deposit) revert ExceedsDeposit();
        if (_recover(voucherDigest(channelId, cumulativeAmount), signature) != c.signer) revert BadSignature();
        paid = cumulativeAmount - c.redeemed;
        c.redeemed = uint128(cumulativeAmount);
    }

    function _close(bytes32 channelId, Channel storage c, uint256 paidNow) internal {
        c.closed = true;
        uint256 refund = uint256(c.deposit) - c.redeemed;
        emit Closed(channelId, paidNow, refund);
        if (paidNow > 0) _push(c.token, c.provider, paidNow);
        if (refund > 0) _push(c.token, c.payer, refund);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_ORDER) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Tollgate"), keccak256("1"), block.chainid, address(this))
        );
    }

    function _pull(IERC20 token, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        if (token.balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    function _push(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}

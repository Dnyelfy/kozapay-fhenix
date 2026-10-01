// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint128, ebool, externalEuint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title KozaPay
/// @notice Private ETH payments on Fhenix CoFHE.
///         Deposits are public (the on-ramp). After that, balances and
///         transfer amounts are encrypted: only the owner of a balance, and the
///         two sides of a payment, can decrypt them.
contract KozaPay {
    struct Payment {
        address from;
        address to;
        euint128 amount;
        uint64 createdAt;
        bool claimed;
        bool recalled;
    }

    uint256 public constant MAX_PAYROLL = 20;

    mapping(address => euint128) private _balances;
    mapping(address => euint128) private _pendingWithdraw;
    mapping(address => bool) public hasPendingWithdraw;
    Payment[] private _payments;

    euint128 private immutable ZERO;

    event Deposited(address indexed user, uint256 amount);
    event PaymentCreated(uint256 indexed id, address indexed from, address indexed to);
    event PaymentClaimed(uint256 indexed id);
    event PaymentRecalled(uint256 indexed id);
    event WithdrawRequested(address indexed user);
    event Withdrawn(address indexed user, uint256 amount);

    error ZeroAmount();
    error AmountTooLarge();
    error BadRecipient();
    error BadPayroll();
    error NotRecipient();
    error NotSender();
    error AlreadySettled();
    error UnknownPayment();
    error WithdrawPending();
    error NoPendingWithdraw();
    error BadDecryptProof();
    error TransferFailed();

    bool private _locked;
    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    constructor() {
        euint128 zero = FHE.asEuint128(0);
        FHE.allowThis(zero);
        ZERO = zero;
    }

    // ---------------------------------------------------------------- deposit

    /// @notice Put ETH into your private balance. The deposited amount is public.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value > type(uint128).max) revert AmountTooLarge();
        euint128 amount = FHE.asEuint128(msg.value);
        _setBalance(msg.sender, FHE.add(_balanceOrZero(msg.sender), amount));
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------- private payments

    /// @notice Send an encrypted amount from your balance. If your balance is too
    ///         small, the payment is created with an encrypted zero instead.
    ///         You can recall it until the recipient claims it.
    function send(address to, externalEuint128 amount, bytes calldata proof) external returns (uint256 id) {
        if (to == address(0) || to == msg.sender) revert BadRecipient();
        euint128 requested = FHE.asEuint128(amount, proof);
        id = _createPayment(msg.sender, to, requested);
    }

    /// @notice Pay up to 20 recipients in one transaction. Each recipient can only
    ///         decrypt their own amount.
    function payroll(address[] calldata to, externalEuint128[] calldata amounts, bytes calldata proof)
        external
        returns (uint256 firstId)
    {
        uint256 n = to.length;
        if (n == 0 || n > MAX_PAYROLL || amounts.length != n) revert BadPayroll();
        euint128[] memory requested = FHE.asEuint128s(amounts, proof);
        firstId = _payments.length;
        for (uint256 i = 0; i < n; i++) {
            if (to[i] == address(0) || to[i] == msg.sender) revert BadRecipient();
            _createPayment(msg.sender, to[i], requested[i]);
        }
    }

    /// @notice Recipient moves a payment into their own private balance.
    function claim(uint256 id) external {
        Payment storage p = _payment(id);
        if (msg.sender != p.to) revert NotRecipient();
        if (p.claimed || p.recalled) revert AlreadySettled();
        p.claimed = true;
        _setBalance(p.to, FHE.add(_balanceOrZero(p.to), p.amount));
        emit PaymentClaimed(id);
    }

    /// @notice Sender takes back a payment the recipient has not claimed yet.
    function recall(uint256 id) external {
        Payment storage p = _payment(id);
        if (msg.sender != p.from) revert NotSender();
        if (p.claimed || p.recalled) revert AlreadySettled();
        p.recalled = true;
        _setBalance(p.from, FHE.add(_balanceOrZero(p.from), p.amount));
        emit PaymentRecalled(id);
    }

    // --------------------------------------------------------------- withdraw

    /// @notice Step 1: set aside `amount` wei from your balance for withdrawal.
    ///         If your balance is too small, an encrypted zero is set aside.
    function requestWithdraw(uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (hasPendingWithdraw[msg.sender]) revert WithdrawPending();
        euint128 bal = _balanceOrZero(msg.sender);
        euint128 req = FHE.asEuint128(amount);
        ebool ok = FHE.lte(req, bal);
        euint128 moved = FHE.select(ok, req, ZERO);
        _setBalance(msg.sender, FHE.sub(bal, moved));
        FHE.allowThis(moved);
        FHE.allow(moved, msg.sender);
        _pendingWithdraw[msg.sender] = moved;
        hasPendingWithdraw[msg.sender] = true;
        emit WithdrawRequested(msg.sender);
    }

    /// @notice Step 2: submit the decrypted amount with the threshold network's
    ///         signature, and receive the ETH.
    function finalizeWithdraw(uint128 amount, bytes calldata signature) external nonReentrant {
        if (!hasPendingWithdraw[msg.sender]) revert NoPendingWithdraw();
        euint128 moved = _pendingWithdraw[msg.sender];
        if (!FHE.verifyDecryptResult(moved, amount, signature)) revert BadDecryptProof();
        hasPendingWithdraw[msg.sender] = false;
        _pendingWithdraw[msg.sender] = euint128.wrap(bytes32(0));
        if (amount > 0) {
            (bool sent, ) = payable(msg.sender).call{value: amount}("");
            if (!sent) revert TransferFailed();
        }
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function encBalanceOf(address user) external view returns (euint128) {
        return _balances[user];
    }

    function pendingWithdrawOf(address user) external view returns (euint128) {
        return _pendingWithdraw[user];
    }

    function paymentsCount() external view returns (uint256) {
        return _payments.length;
    }

    function payments(uint256 id)
        external
        view
        returns (address from, address to, euint128 amount, uint64 createdAt, bool claimed, bool recalled)
    {
        Payment storage p = _payment(id);
        return (p.from, p.to, p.amount, p.createdAt, p.claimed, p.recalled);
    }

    // --------------------------------------------------------------- internal

    function _createPayment(address from, address to, euint128 requested) internal returns (uint256 id) {
        euint128 bal = _balanceOrZero(from);
        ebool ok = FHE.lte(requested, bal);
        euint128 moved = FHE.select(ok, requested, ZERO);
        _setBalance(from, FHE.sub(bal, moved));
        FHE.allowThis(moved);
        FHE.allow(moved, from);
        FHE.allow(moved, to);
        id = _payments.length;
        _payments.push(Payment(from, to, moved, uint64(block.timestamp), false, false));
        emit PaymentCreated(id, from, to);
    }

    function _balanceOrZero(address user) internal view returns (euint128) {
        euint128 b = _balances[user];
        return euint128.unwrap(b) == bytes32(0) ? ZERO : b;
    }

    function _setBalance(address user, euint128 value) internal {
        _balances[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
    }

    function _payment(uint256 id) internal view returns (Payment storage) {
        if (id >= _payments.length) revert UnknownPayment();
        return _payments[id];
    }
}

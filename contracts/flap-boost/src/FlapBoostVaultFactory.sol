// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlapBoostVault} from "./FlapBoostVault.sol";

/// @notice Exactly one shared BNB Vault per owner and token.
contract FlapBoostVaultFactory {
    struct OperationOptions {
        address targetToken;
        uint256 minTokensPerBNB;
        uint64 interval;
        uint8 outputMode;
        uint8 randomRecipientCount;
        address retainRecipient;
        address[] recipients;
    }

    mapping(address owner => mapping(address token => address vault)) public vaultOf;
    mapping(address owner => address[] vaults) private _vaults;
    address[] private _allVaults;

    event VaultCreated(address indexed owner, address indexed token, address indexed vault);
    event OperationCreated(address indexed owner, address indexed vault, uint256 indexed operationId);

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaults[owner];
    }

    /// @notice Number of Vaults created by this Factory across all owners.
    function vaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    /// @notice A bounded public page of Vaults in creation order.
    function vaultsRange(uint256 offset, uint256 limit) external view returns (address[] memory vaults) {
        if (offset >= _allVaults.length || limit == 0) return new address[](0);
        uint256 length = _allVaults.length - offset;
        if (length > limit) length = limit;
        if (length > 50) length = 50;
        vaults = new address[](length);
        for (uint256 i; i < length; ++i) vaults[i] = _allVaults[offset + i];
    }

    function createFixedBNBOperation(OperationOptions calldata options, uint256 bnbPerRound)
        external
        returns (address vault, uint256 operationId)
    {
        return _create(options, FlapBoostVault.BuyMode.FIXED_BNB, bnbPerRound, 0, 0, 0);
    }

    function createFixedTokenAmountOperation(OperationOptions calldata options, uint256 tokenAmountPerRound)
        external
        returns (address vault, uint256 operationId)
    {
        return _create(options, FlapBoostVault.BuyMode.FIXED_TOKEN_AMOUNT, 0, tokenAmountPerRound, 0, 0);
    }

    function createBalancePercentageOperation(
        OperationOptions calldata options,
        uint16 balanceBps,
        uint256 maxBNBPerRound
    ) external returns (address vault, uint256 operationId) {
        return _create(options, FlapBoostVault.BuyMode.BALANCE_BPS, 0, 0, balanceBps, maxBNBPerRound);
    }

    function _create(
        OperationOptions calldata options,
        FlapBoostVault.BuyMode mode,
        uint256 fixedBNB,
        uint256 fixedTokens,
        uint16 balanceBps,
        uint256 maxBNB
    ) private returns (address vault, uint256 operationId) {
        vault = vaultOf[msg.sender][options.targetToken];
        if (vault == address(0)) {
            vault = address(new FlapBoostVault(msg.sender, options.targetToken));
            vaultOf[msg.sender][options.targetToken] = vault;
            _vaults[msg.sender].push(vault);
            _allVaults.push(vault);
            emit VaultCreated(msg.sender, options.targetToken, vault);
        }
        operationId = FlapBoostVault(payable(vault))
            .addOperation(
                FlapBoostVault.OperationConfig({
                    buyMode: mode,
                    fixedBNBPerRound: fixedBNB,
                    fixedTokenAmountPerRound: fixedTokens,
                    balanceBps: balanceBps,
                    maxBNBPerRound: maxBNB,
                    minTokensPerBNB: options.minTokensPerBNB,
                    interval: options.interval,
                    outputMode: options.outputMode,
                    randomRecipientCount: options.randomRecipientCount,
                    retainRecipient: options.retainRecipient,
                    recipients: options.recipients
                })
            );
        emit OperationCreated(msg.sender, vault, operationId);
    }
}

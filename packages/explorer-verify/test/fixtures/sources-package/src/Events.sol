// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Events.sol and VaultMath.sol import each other: a cycle.
import {VaultMath} from "./VaultMath.sol";

interface IVaultEvents {
    event Deposited(address indexed account, uint256 amount);
}

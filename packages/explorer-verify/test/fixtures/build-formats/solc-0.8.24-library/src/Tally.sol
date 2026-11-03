// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library Tally {
    function add(uint256 total, uint256 amount) external pure returns (uint256) {
        return total + amount;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract Counter {
    uint256 public value;
    constructor(uint256 initial) { value = initial; }
    function increment() external { value += 1; }
}

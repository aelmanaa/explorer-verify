// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract Base {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

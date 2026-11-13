// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Context} from "./Context.sol";

abstract contract Ownable is Context {
    error NotOwner();

    address private _owner;

    constructor(address owner_) {
        _owner = owner_;
    }

    modifier onlyOwner() {
        if (_msgSender() != _owner) revert NotOwner();
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }
}

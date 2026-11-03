// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";

contract Greeter is Base {
    string public greeting;

    constructor(address owner_, string memory greeting_) Base(owner_) {
        greeting = greeting_;
    }
}

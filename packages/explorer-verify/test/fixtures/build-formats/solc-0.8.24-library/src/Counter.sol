// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Tally} from "./Tally.sol";

contract Counter {
    uint256 public count;

    function bump(uint256 amount) external {
        count = Tally.add(count, amount);
    }
}

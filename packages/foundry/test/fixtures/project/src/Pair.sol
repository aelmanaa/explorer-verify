// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Ping {
    uint256 public pings;

    function ping() external {
        pings += 1;
    }
}

contract Pong {
    uint256 public pongs;

    function pong() external {
        pongs += 1;
    }
}

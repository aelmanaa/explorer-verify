// SPDX-License-Identifier: MIT
pragma solidity =0.8.20;

import {Context} from "../lib/utils/Context.sol";

contract Old is Context {
    function who() external view returns (address) {
        return _msgSender();
    }
}

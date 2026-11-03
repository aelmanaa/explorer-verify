// SPDX-License-Identifier: MIT
pragma solidity =0.8.24;

import {Context} from "../lib/utils/Context.sol";

contract New is Context {
    function who() external view returns (address) {
        return _msgSender();
    }
}

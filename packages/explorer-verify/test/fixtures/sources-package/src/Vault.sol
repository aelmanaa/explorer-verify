// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@acl/Ownable.sol";
import "./VaultMath.sol" as Maths;
import * as Events from './Events.sol';
// import "./Unused.sol";
/* import {Unused} from "./Unused.sol"; */

/// @notice Holds deposits and lets its owner sweep them.
contract Vault is Ownable, Events.IVaultEvents {
    string public constant NOTE = "import \"./Unused.sol\";";

    mapping(address => uint256) public balanceOf;

    constructor(address owner_) Ownable(owner_) {}

    function deposit() external payable {
        balanceOf[msg.sender] = Maths.VaultMath.add(balanceOf[msg.sender], msg.value);
        emit Deposited(msg.sender, msg.value);
    }

    function sweep(address payable to) external onlyOwner {
        to.transfer(address(this).balance);
    }
}

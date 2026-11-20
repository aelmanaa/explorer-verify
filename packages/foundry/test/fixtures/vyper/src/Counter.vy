# pragma version ~=0.4.3

from .interfaces import ICounter
from . import ownable

implements: ICounter

initializes: ownable

exports: ownable.owner

count: public(uint256)


@deploy
def __init__(start: uint256):
    ownable.__init__()
    self.count = start


@external
def increment():
    ownable._check_owner()
    self.count += 1

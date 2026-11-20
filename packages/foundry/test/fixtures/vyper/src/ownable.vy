# pragma version ~=0.4.3

owner: public(address)


@deploy
def __init__():
    self.owner = msg.sender


@internal
def _check_owner():
    assert msg.sender == self.owner, "ownable: not owner"

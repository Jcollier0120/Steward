from hello import hello


def test_says_hello():
    assert hello() == "Hello, world!"
    assert hello("Steward") == "Hello, Steward!"

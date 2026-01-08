from app import time_utils


def test_parse_time_lpu_valid_cases():
    normalized, time_24, start, end = time_utils.parse_time_lpu("10:00a-12:00p")
    assert normalized == "10:00a-12:00p"
    assert time_24 == "10:00-12:00"
    assert start == 600
    assert end == 720

    normalized, time_24, start, end = time_utils.parse_time_lpu("11:00a-2:00p")
    assert normalized == "11:00a-2:00p"
    assert time_24 == "11:00-14:00"
    assert start == 660
    assert end == 840

    normalized, time_24, start, end = time_utils.parse_time_lpu("12:00p-3:00p")
    assert normalized == "12:00p-3:00p"
    assert time_24 == "12:00-15:00"
    assert start == 720
    assert end == 900

    normalized, time_24, start, end = time_utils.parse_time_lpu("12:00a-1:00a")
    assert normalized == "12:00a-1:00a"
    assert time_24 == "00:00-01:00"
    assert start == 0
    assert end == 60


def test_parse_time_lpu_rejects_invalid_range():
    try:
        time_utils.parse_time_lpu("10:00a-9:00a")
    except ValueError as exc:
        assert "Invalid Time (LPU Std)" in str(exc)
    else:
        raise AssertionError("Expected ValueError")

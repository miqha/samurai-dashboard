"""Dashboard cutoff timezone, independent of an optional system IANA database.

Only current rolling-year/cutoff dates use this value. Moscow has used UTC+03
without seasonal changes since October 2014; historical event timestamps retain
their source offsets and are never localized with this helper.
"""
from datetime import timedelta, timezone

MOSCOW = timezone(timedelta(hours=3), "Europe/Moscow")

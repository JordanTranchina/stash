"""
conftest.py – runs before pytest collects any test files.

We mock the `supabase` module here because it depends on `pyroaring`
(a C extension) which may not be buildable in all environments.
The production code uses `supabase` via the Supabase Python client;
all of those calls are mocked in the individual test files anyway.
"""

import sys
from unittest.mock import MagicMock

# Create a minimal fake "supabase" module so that
# `from supabase import create_client, Client` in script.py succeeds.
fake_supabase = MagicMock()
fake_supabase.create_client = MagicMock(return_value=None)
fake_supabase.Client = MagicMock()

sys.modules.setdefault("supabase", fake_supabase)

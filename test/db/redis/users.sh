# The ACL users every test server has, as redis-server arguments; sourced by the entrypoints.
# `default` stays passwordless so the healthchecks and the seed need no credentials.
USERS='--user table_craft on >table_craft ~* &* +@all --user limited on >limited ~* &* +@all -memory -object -config'

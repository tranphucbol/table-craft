# The users every test server has, as redis-server arguments; sourced by the entrypoints.
# 6.0 and later: ACL users, `default` passwordless so the healthchecks and the seed need no
# credentials. Before 6.0 (REDIS_AUTH=password): no ACL users, one password for every client, which
# redis-cli takes from REDISCLI_AUTH (compose.yml sets it) and replicas from masterauth.
if [ "${REDIS_AUTH:-}" = "password" ]; then
  USERS='--requirepass table_craft --masterauth table_craft'
else
  USERS='--user table_craft on >table_craft ~* &* +@all --user limited on >limited ~* &* +@all -memory -object -config'
fi

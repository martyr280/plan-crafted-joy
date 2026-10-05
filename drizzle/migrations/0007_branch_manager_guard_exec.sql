-- Role-guard triggers run as the calling role; let authenticated evaluate the (read-only) guard helper.
GRANT EXECUTE ON FUNCTION private.bm_rpc_active() TO authenticated;
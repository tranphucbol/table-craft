const lines = (...rows: string[]): string => rows.join("\n");

/** The reference layout from plan 030, as DataGrip writes it. */
export const GOLDEN = lines(
  "EXPLAIN",
  "SELECT trans_id,",
  "       app_id,",
  "       event_code,",
  "       product_code,",
  "       JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.sources[0].asset_type'))      AS source_asset,",
  "       JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.destinations[0].asset_type')) AS dest_asset,",
  "       JSON_EXTRACT(extra_data, '$.order.order_amount')                       AS amount,",
  "       JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.order.order_ref_id'))         AS order_ref_id,",
  "       status,",
  "       trans_status,",
  "       reason_status,",
  "       JSON_EXTRACT(reason_status, '$.metadata.sv_code')                      AS sv_code,",
  "       JSON_EXTRACT(reason_status, '$.metadata.gw_code')                      AS gw_code,",
  "       JSON_EXTRACT(reason_status, '$.metadata.gw_trans_status')              AS gw_trans_status,",
  "       JSON_EXTRACT(reason_status, '$.metadata.gw_trans_id')                  AS gw_trans_id,",
  "       JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.initiator.account_id'))       AS account_id,",
  "       created_at,",
  "       updated_at",
  "FROM order_events_202607 USE INDEX (order_events_created_at_idx)",
  "WHERE created_at > '2026-07-09 03:00:00'",
  "  AND created_at < '2026-07-09 03:45:00'",
  "  AND status NOT IN ('SUCCESS')",
  "  AND (",
  "    JSON_EXTRACT(extra_data, '$.sources[0].asset_type') IN ('BDA', 'BDC', 'BIC', 'BID', 'BCO', 'BNP', 'FDA', 'MDA') OR",
  "    JSON_EXTRACT(extra_data, '$.destinations[0].asset_type') IN ('BDA', 'BDC', 'BIC', 'BID', 'NMCA', 'MDA', 'FDA'));",
);

/** The golden squashed onto one line with lower-case keywords; function names stay as written. */
export const GOLDEN_ONE_LINE =
  "explain select trans_id, app_id, event_code, product_code, " +
  "JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.sources[0].asset_type')) as source_asset, " +
  "JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.destinations[0].asset_type')) as dest_asset, " +
  "JSON_EXTRACT(extra_data, '$.order.order_amount') as amount, " +
  "JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.order.order_ref_id')) as order_ref_id, " +
  "status, trans_status, reason_status, " +
  "JSON_EXTRACT(reason_status, '$.metadata.sv_code') as sv_code, " +
  "JSON_EXTRACT(reason_status, '$.metadata.gw_code') as gw_code, " +
  "JSON_EXTRACT(reason_status, '$.metadata.gw_trans_status') as gw_trans_status, " +
  "JSON_EXTRACT(reason_status, '$.metadata.gw_trans_id') as gw_trans_id, " +
  "JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.initiator.account_id')) as account_id, " +
  "created_at, updated_at from order_events_202607 use index (order_events_created_at_idx) " +
  "where created_at > '2026-07-09 03:00:00' and created_at < '2026-07-09 03:45:00' " +
  "and status not in ('SUCCESS') and (JSON_EXTRACT(extra_data, '$.sources[0].asset_type') in " +
  "('BDA', 'BDC', 'BIC', 'BID', 'BCO', 'BNP', 'FDA', 'MDA') or " +
  "JSON_EXTRACT(extra_data, '$.destinations[0].asset_type') in ('BDA', 'BDC', 'BIC', 'BID', 'NMCA', 'MDA', 'FDA'));";

export const GOLDEN_MESSY = lines(
  "explain   select trans_id ,app_id,event_code ,  product_code,",
  "JSON_UNQUOTE( JSON_EXTRACT( extra_data,'$.sources[0].asset_type' ) ) as source_asset,",
  "  JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.destinations[0].asset_type'))   as   dest_asset,",
  "JSON_EXTRACT(extra_data, '$.order.order_amount') as amount, JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.order.order_ref_id')) as order_ref_id,",
  "status, trans_status, reason_status, JSON_EXTRACT(reason_status, '$.metadata.sv_code') as sv_code,",
  "JSON_EXTRACT(reason_status, '$.metadata.gw_code') as gw_code, JSON_EXTRACT(reason_status, '$.metadata.gw_trans_status') as gw_trans_status,",
  "JSON_EXTRACT(reason_status, '$.metadata.gw_trans_id') as gw_trans_id, JSON_UNQUOTE(JSON_EXTRACT(extra_data, '$.initiator.account_id')) as account_id,",
  "created_at, updated_at",
  "from order_events_202607 use index(order_events_created_at_idx)",
  "where created_at > '2026-07-09 03:00:00'",
  "\tand created_at < '2026-07-09 03:45:00' and status not in ( 'SUCCESS' )",
  "and ( JSON_EXTRACT(extra_data, '$.sources[0].asset_type') in ('BDA','BDC','BIC','BID','BCO','BNP','FDA','MDA')",
  "     or JSON_EXTRACT(extra_data, '$.destinations[0].asset_type') in ('BDA', 'BDC', 'BIC', 'BID', 'NMCA', 'MDA', 'FDA') ) ;",
);

/** The table the golden explains, so MySQL can plan it; columns as the golden reads them. */
export const GOLDEN_TABLE = "order_events_202607";

export const GOLDEN_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${GOLDEN_TABLE} (
  trans_id BIGINT PRIMARY KEY,
  app_id INT,
  event_code VARCHAR(32),
  product_code VARCHAR(32),
  extra_data JSON,
  status VARCHAR(16),
  trans_status VARCHAR(16),
  reason_status JSON,
  created_at DATETIME,
  updated_at DATETIME,
  INDEX order_events_created_at_idx (created_at)
)`;

const lines = (...rows: string[]): string => rows.join("\n");

/** The reference layout from plan 030, as DataGrip writes it. */
export const GOLDEN = lines(
  "EXPLAIN",
  "SELECT event_id,",
  "       shop_id,",
  "       event_type,",
  "       sku_code,",
  "       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.items[0].category'))    AS first_category,",
  "       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.shipments[0].carrier')) AS carrier,",
  "       JSON_EXTRACT(payload, '$.order.total_amount')                 AS amount,",
  "       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.order.external_ref'))   AS external_ref,",
  "       status,",
  "       payment_status,",
  "       failure_detail,",
  "       JSON_EXTRACT(failure_detail, '$.gateway.error_code')          AS error_code,",
  "       JSON_EXTRACT(failure_detail, '$.gateway.decline_code')        AS decline_code,",
  "       JSON_EXTRACT(failure_detail, '$.gateway.attempt_status')      AS attempt_status,",
  "       JSON_EXTRACT(failure_detail, '$.gateway.attempt_id')          AS attempt_id,",
  "       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.customer.account_id'))  AS account_id,",
  "       created_at,",
  "       updated_at",
  "FROM order_events_202607 USE INDEX (order_events_created_at_idx)",
  "WHERE created_at > '2026-07-09 03:00:00'",
  "  AND created_at < '2026-07-09 03:45:00'",
  "  AND status NOT IN ('DELIVERED')",
  "  AND (",
  "    JSON_EXTRACT(payload, '$.items[0].category') IN ('BOOK',",
  "                                                     'TOY',",
  "                                                     'GAME',",
  "                                                     'FOOD',",
  "                                                     'HOME',",
  "                                                     'BABY',",
  "                                                     'PETS',",
  "                                                     'TECH') OR",
  "    JSON_EXTRACT(payload, '$.shipments[0].carrier') IN ('DHL',",
  "                                                        'UPS',",
  "                                                        'USPS',",
  "                                                        'FEDEX',",
  "                                                        'TNT',",
  "                                                        'GLS',",
  "                                                        'DPD'));",
);

/** The golden squashed onto one line with lower-case keywords; function names stay as written. */
export const GOLDEN_ONE_LINE =
  "explain select event_id, shop_id, event_type, sku_code, " +
  "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.items[0].category')) as first_category, " +
  "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.shipments[0].carrier')) as carrier, " +
  "JSON_EXTRACT(payload, '$.order.total_amount') as amount, " +
  "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.order.external_ref')) as external_ref, " +
  "status, payment_status, failure_detail, " +
  "JSON_EXTRACT(failure_detail, '$.gateway.error_code') as error_code, " +
  "JSON_EXTRACT(failure_detail, '$.gateway.decline_code') as decline_code, " +
  "JSON_EXTRACT(failure_detail, '$.gateway.attempt_status') as attempt_status, " +
  "JSON_EXTRACT(failure_detail, '$.gateway.attempt_id') as attempt_id, " +
  "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.customer.account_id')) as account_id, " +
  "created_at, updated_at from order_events_202607 use index (order_events_created_at_idx) " +
  "where created_at > '2026-07-09 03:00:00' and created_at < '2026-07-09 03:45:00' " +
  "and status not in ('DELIVERED') and (JSON_EXTRACT(payload, '$.items[0].category') in " +
  "('BOOK', 'TOY', 'GAME', 'FOOD', 'HOME', 'BABY', 'PETS', 'TECH') or " +
  "JSON_EXTRACT(payload, '$.shipments[0].carrier') in ('DHL', 'UPS', 'USPS', 'FEDEX', 'TNT', 'GLS', 'DPD'));";

export const GOLDEN_MESSY = lines(
  "explain   select event_id ,shop_id,event_type ,  sku_code,",
  "JSON_UNQUOTE( JSON_EXTRACT( payload,'$.items[0].category' ) ) as first_category,",
  "  JSON_UNQUOTE(JSON_EXTRACT(payload, '$.shipments[0].carrier'))   as   carrier,",
  "JSON_EXTRACT(payload, '$.order.total_amount') as amount, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.order.external_ref')) as external_ref,",
  "status, payment_status, failure_detail, JSON_EXTRACT(failure_detail, '$.gateway.error_code') as error_code,",
  "JSON_EXTRACT(failure_detail, '$.gateway.decline_code') as decline_code, JSON_EXTRACT(failure_detail, '$.gateway.attempt_status') as attempt_status,",
  "JSON_EXTRACT(failure_detail, '$.gateway.attempt_id') as attempt_id, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.customer.account_id')) as account_id,",
  "created_at, updated_at",
  "from order_events_202607 use index(order_events_created_at_idx)",
  "where created_at > '2026-07-09 03:00:00'",
  "\tand created_at < '2026-07-09 03:45:00' and status not in ( 'DELIVERED' )",
  "and ( JSON_EXTRACT(payload, '$.items[0].category') in ('BOOK','TOY','GAME','FOOD','HOME','BABY','PETS','TECH')",
  "     or JSON_EXTRACT(payload, '$.shipments[0].carrier') in ('DHL', 'UPS', 'USPS', 'FEDEX', 'TNT', 'GLS', 'DPD') ) ;",
);

/** The table the golden explains, so MySQL can plan it; columns as the golden reads them. */
export const GOLDEN_TABLE = "order_events_202607";

export const GOLDEN_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${GOLDEN_TABLE} (
  event_id BIGINT PRIMARY KEY,
  shop_id INT,
  event_type VARCHAR(32),
  sku_code VARCHAR(32),
  payload JSON,
  status VARCHAR(16),
  payment_status VARCHAR(16),
  failure_detail JSON,
  created_at DATETIME,
  updated_at DATETIME,
  INDEX order_events_created_at_idx (created_at)
)`;

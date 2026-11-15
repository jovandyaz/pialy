-- Keep only the last 4 digits of the payer account stored in raw webhook payloads.
UPDATE "payment_events"
SET "raw" = jsonb_set("raw", '{metadata,clabe}', to_jsonb(lpad(right("raw" #>> '{metadata,clabe}', 4), length("raw" #>> '{metadata,clabe}'), '*')))
WHERE "raw" #>> '{metadata,clabe}' IS NOT NULL
  AND length("raw" #>> '{metadata,clabe}') > 4
  AND "raw" #>> '{metadata,clabe}' !~ '^\*';

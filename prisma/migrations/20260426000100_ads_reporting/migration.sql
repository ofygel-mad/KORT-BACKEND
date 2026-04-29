-- CreateTable exchange_rates
CREATE TABLE IF NOT EXISTS "exchange_rates" (
    "id"         TEXT NOT NULL,
    "base"       TEXT NOT NULL,
    "quote"      TEXT NOT NULL,
    "rate"       DOUBLE PRECISION NOT NULL,
    "source"     TEXT NOT NULL DEFAULT 'NBK',
    "rate_date"  TIMESTAMP(3) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable ad_campaigns
CREATE TABLE IF NOT EXISTS "ad_campaigns" (
    "id"           TEXT NOT NULL,
    "org_id"       TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "channel"      TEXT NOT NULL DEFAULT 'target',
    "status"       TEXT NOT NULL DEFAULT 'active',
    "manager_name" TEXT,
    "creative_url" TEXT,
    "notes"        TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable ad_daily_metrics
CREATE TABLE IF NOT EXISTS "ad_daily_metrics" (
    "id"            TEXT NOT NULL,
    "org_id"        TEXT NOT NULL,
    "campaign_id"   TEXT NOT NULL,
    "date"          TIMESTAMP(3) NOT NULL,
    "spend_usd"     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "exchange_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spend_kzt"     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions"   INTEGER NOT NULL DEFAULT 0,
    "reach"         INTEGER NOT NULL DEFAULT 0,
    "clicks"        INTEGER NOT NULL DEFAULT 0,
    "leads"         INTEGER NOT NULL DEFAULT 0,
    "sales"         INTEGER NOT NULL DEFAULT 0,
    "notes"         TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "exchange_rates_base_quote_rate_date_source_key"
    ON "exchange_rates"("base", "quote", "rate_date", "source");

CREATE INDEX IF NOT EXISTS "exchange_rates_base_quote_rate_date_idx"
    ON "exchange_rates"("base", "quote", "rate_date");

CREATE INDEX IF NOT EXISTS "ad_campaigns_org_id_channel_status_idx"
    ON "ad_campaigns"("org_id", "channel", "status");

CREATE INDEX IF NOT EXISTS "ad_campaigns_org_id_name_idx"
    ON "ad_campaigns"("org_id", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "ad_daily_metrics_campaign_id_date_key"
    ON "ad_daily_metrics"("campaign_id", "date");

CREATE INDEX IF NOT EXISTS "ad_daily_metrics_org_id_date_idx"
    ON "ad_daily_metrics"("org_id", "date");

CREATE INDEX IF NOT EXISTS "ad_daily_metrics_org_id_campaign_id_idx"
    ON "ad_daily_metrics"("org_id", "campaign_id");

-- AddForeignKey
ALTER TABLE "ad_campaigns"
    ADD CONSTRAINT "ad_campaigns_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_daily_metrics"
    ADD CONSTRAINT "ad_daily_metrics_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ad_daily_metrics"
    ADD CONSTRAINT "ad_daily_metrics_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "avatar_url" TEXT,
    "password" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'basic',
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "industry" TEXT,
    "onboarding_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "joined_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'manager',
    "auto_approve" BOOLEAN NOT NULL DEFAULT true,
    "kind" TEXT NOT NULL DEFAULT 'referral',
    "created_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "used_at" TIMESTAMP(3),
    "used_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "requested_role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "membership_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "company_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "company_name" TEXT,
    "source" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "pipeline" TEXT NOT NULL DEFAULT 'qualifier',
    "assigned_to" TEXT,
    "assigned_name" TEXT,
    "callback_at" TIMESTAMP(3),
    "meeting_at" TIMESTAMP(3),
    "budget" DOUBLE PRECISION,
    "comment" TEXT,
    "checklist_done" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_history" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "lead_id" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "company_name" TEXT,
    "source" TEXT,
    "title" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'awaiting_meeting',
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 20,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "assigned_to" TEXT,
    "assigned_name" TEXT,
    "qualifier_name" TEXT,
    "expected_close_at" TIMESTAMP(3),
    "meeting_at" TIMESTAMP(3),
    "stage_entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "won_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),
    "lost_reason" TEXT,
    "lost_comment" TEXT,
    "notes" TEXT,
    "checklist_done" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_activities" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "deal_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'todo',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "assigned_to" TEXT,
    "assigned_name" TEXT,
    "created_by" TEXT,
    "task_type" TEXT NOT NULL DEFAULT 'manual',
    "due_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "linked_entity_type" TEXT,
    "linked_entity_id" TEXT,
    "linked_entity_title" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_subtasks" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_subtasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_activities" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_profiles" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT 'Чапан',
    "descriptor" TEXT NOT NULL DEFAULT '',
    "order_prefix" TEXT NOT NULL DEFAULT 'ЧП',
    "order_counter" INTEGER NOT NULL DEFAULT 0,
    "request_counter" INTEGER NOT NULL DEFAULT 0,
    "public_intake_title" TEXT NOT NULL DEFAULT 'Оставьте заявку на пошив',
    "public_intake_description" TEXT NOT NULL DEFAULT '',
    "public_intake_enabled" BOOLEAN NOT NULL DEFAULT true,
    "support_label" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "chapan_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_workers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "chapan_workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_catalog_products" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "chapan_catalog_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_catalog_fabrics" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "chapan_catalog_fabrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_catalog_sizes" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "chapan_catalog_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_clients" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapan_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_requests" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "request_number" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "messengers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "delivery_method" TEXT,
    "lead_source" TEXT,
    "preferred_contact" TEXT NOT NULL DEFAULT 'phone',
    "desired_date" TIMESTAMP(3),
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'public_form',
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapan_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_request_items" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "fabric_preference" TEXT,
    "size" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,

    CONSTRAINT "chapan_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_orders" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "client_phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "payment_status" TEXT NOT NULL DEFAULT 'not_paid',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paid_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "due_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapan_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "fabric" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "workshop_notes" TEXT,

    CONSTRAINT "chapan_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_production_tasks" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "fabric" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assigned_to" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "notes" TEXT,
    "defects" TEXT,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "block_reason" TEXT,

    CONSTRAINT "chapan_production_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "notes" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapan_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_transfers" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "confirmed_by_manager" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by_client" BOOLEAN NOT NULL DEFAULT false,
    "transferred_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "chapan_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapan_activities" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapan_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "memberships_org_id_idx" ON "memberships"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_org_id_key" ON "memberships"("user_id", "org_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_key" ON "invites"("token");

-- CreateIndex
CREATE INDEX "invites_org_id_idx" ON "invites"("org_id");

-- CreateIndex
CREATE INDEX "membership_requests_org_id_status_idx" ON "membership_requests"("org_id", "status");

-- CreateIndex
CREATE INDEX "customers_org_id_idx" ON "customers"("org_id");

-- CreateIndex
CREATE INDEX "leads_org_id_pipeline_stage_idx" ON "leads"("org_id", "pipeline", "stage");

-- CreateIndex
CREATE INDEX "lead_history_lead_id_idx" ON "lead_history"("lead_id");

-- CreateIndex
CREATE INDEX "deals_org_id_stage_idx" ON "deals"("org_id", "stage");

-- CreateIndex
CREATE INDEX "deal_activities_deal_id_idx" ON "deal_activities"("deal_id");

-- CreateIndex
CREATE INDEX "tasks_org_id_status_idx" ON "tasks"("org_id", "status");

-- CreateIndex
CREATE INDEX "task_subtasks_task_id_idx" ON "task_subtasks"("task_id");

-- CreateIndex
CREATE INDEX "task_activities_task_id_idx" ON "task_activities"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_profiles_org_id_key" ON "chapan_profiles"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_workers_org_id_name_key" ON "chapan_workers"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_catalog_products_org_id_name_key" ON "chapan_catalog_products"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_catalog_fabrics_org_id_name_key" ON "chapan_catalog_fabrics"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_catalog_sizes_org_id_name_key" ON "chapan_catalog_sizes"("org_id", "name");

-- CreateIndex
CREATE INDEX "chapan_clients_org_id_idx" ON "chapan_clients"("org_id");

-- CreateIndex
CREATE INDEX "chapan_requests_org_id_status_idx" ON "chapan_requests"("org_id", "status");

-- CreateIndex
CREATE INDEX "chapan_orders_org_id_status_idx" ON "chapan_orders"("org_id", "status");

-- CreateIndex
CREATE INDEX "chapan_orders_org_id_created_at_idx" ON "chapan_orders"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_production_tasks_order_item_id_key" ON "chapan_production_tasks"("order_item_id");

-- CreateIndex
CREATE INDEX "chapan_production_tasks_order_id_idx" ON "chapan_production_tasks"("order_id");

-- CreateIndex
CREATE INDEX "chapan_production_tasks_status_idx" ON "chapan_production_tasks"("status");

-- CreateIndex
CREATE INDEX "chapan_payments_order_id_idx" ON "chapan_payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapan_transfers_order_id_key" ON "chapan_transfers"("order_id");

-- CreateIndex
CREATE INDEX "chapan_activities_order_id_idx" ON "chapan_activities"("order_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_requests" ADD CONSTRAINT "membership_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_history" ADD CONSTRAINT "lead_history_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_subtasks" ADD CONSTRAINT "task_subtasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_profiles" ADD CONSTRAINT "chapan_profiles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_workers" ADD CONSTRAINT "chapan_workers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_catalog_products" ADD CONSTRAINT "chapan_catalog_products_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_catalog_fabrics" ADD CONSTRAINT "chapan_catalog_fabrics_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_catalog_sizes" ADD CONSTRAINT "chapan_catalog_sizes_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_clients" ADD CONSTRAINT "chapan_clients_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_requests" ADD CONSTRAINT "chapan_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_request_items" ADD CONSTRAINT "chapan_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "chapan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_orders" ADD CONSTRAINT "chapan_orders_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_orders" ADD CONSTRAINT "chapan_orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "chapan_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_order_items" ADD CONSTRAINT "chapan_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_production_tasks" ADD CONSTRAINT "chapan_production_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_production_tasks" ADD CONSTRAINT "chapan_production_tasks_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "chapan_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_payments" ADD CONSTRAINT "chapan_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_transfers" ADD CONSTRAINT "chapan_transfers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapan_activities" ADD CONSTRAINT "chapan_activities_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

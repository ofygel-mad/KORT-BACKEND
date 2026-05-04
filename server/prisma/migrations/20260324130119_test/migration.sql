/*
  Warnings:

  - You are about to drop the column `phone_col_added` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `service_credentials` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "phone_col_added";

-- DropTable
DROP TABLE "service_credentials";

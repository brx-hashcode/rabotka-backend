-- CreateTable
CREATE TABLE "profile_categories" (
    "profile_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "profile_categories_pkey" PRIMARY KEY ("profile_id","category_id")
);

-- AddForeignKey
ALTER TABLE "profile_categories" ADD CONSTRAINT "profile_categories_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_categories" ADD CONSTRAINT "profile_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "job_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

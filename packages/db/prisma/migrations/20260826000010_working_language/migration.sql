-- The language a learner actually writes code in.
--
-- Written by hand: `prisma migrate diff` also wanted to DROP concept_name_trgm_idx,
-- concept_alias_name_trgm_idx and concept_sense_vector_idx, because those are created in
-- a raw SQL migration and are invisible to the Prisma schema. They are the resolver's
-- lexical and vector retrieval — dropping them would silently turn concept identity into
-- a sequential scan and a guess.
ALTER TABLE "Learner" ADD COLUMN "workingLanguage" TEXT;

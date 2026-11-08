-- The candidate's answers to the offer's questions, read with their CV.
ALTER TABLE "cv_screening_resumes" ADD COLUMN "application_answers" JSONB;

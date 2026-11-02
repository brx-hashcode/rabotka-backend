-- The CV text, read once at analysis, so a question about the CV does not
-- download and re-read the file. Purged with the file.
ALTER TABLE "cv_screening_resumes" ADD COLUMN "cv_text" TEXT;

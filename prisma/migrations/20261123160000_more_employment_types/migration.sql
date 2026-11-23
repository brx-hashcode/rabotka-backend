-- Consultant, volontariat, apprentissage, intérim: recruited like a CDD (the
-- offer stops at the hire, the business closes it).
ALTER TYPE "EmploymentType" ADD VALUE 'CONSULTANT';
ALTER TYPE "EmploymentType" ADD VALUE 'VOLONTARIAT';
ALTER TYPE "EmploymentType" ADD VALUE 'APPRENTISSAGE';
ALTER TYPE "EmploymentType" ADD VALUE 'INTERIM';

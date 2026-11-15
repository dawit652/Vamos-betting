-- Registration no longer asks for a date of birth (the player confirms 21+; KYC records the verified one).
ALTER TABLE "users" ALTER COLUMN "date_of_birth" DROP NOT NULL;

import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Wave 4 step 3. No AuthModule import, unlike every other module: this is the
 * one public surface and it has no guard to satisfy. The trade-off is written
 * down in OnboardingController's docstring — a sequential reference is
 * guessable, so the status lookup requires the applicant's email and returns
 * only a subset of the row.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}

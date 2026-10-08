import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { OnboardingService } from './onboarding.service';

class VendorApplicationDto {
  /**
   * Company name and NTN are @IsOptional() here ON PURPOSE.
   *
   * Marking them @IsString() makes the ValidationPipe answer a missing field
   * with class-validator's wording — "legalName should be a string" — which is
   * developer-speak and names a JSON key that appears nowhere on the form. The
   * prototype labels these fields "Company name *" and "NTN / Tax ID *", and an
   * applicant who skipped one deserves to be told THAT is missing. So presence
   * is checked in the service, which owns the prototype's wording; the decorators
   * here only constrain values that ARE present.
   */
  @IsOptional() @IsString() @MaxLength(200) legalName?: string;
  @IsOptional() @IsString() @MaxLength(40) ntn?: string;
  @IsOptional() @IsString() @MaxLength(160) contactName?: string;
  // IsEmail, not IsString: the status lookup makes the email load-bearing, so
  // an unparseable one at submit time is a problem worth refusing now rather
  // than discovering when the applicant cannot check on their own application.
  @IsOptional() @IsEmail() @MaxLength(200) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(200) categories?: string;
}

class StatusQueryDto {
  /**
   * Required by the SERVICE (it throws when absent), not by the decorator. An
   * absent query parameter arrives as undefined, and @IsEmail() would reject it
   * with a generic 400 that does not tell the caller what is wrong or that it is
   * fixable. The service's message is the useful one.
   */
  @IsOptional() @IsString() @MaxLength(200) email?: string;
}

/**
 * The PUBLIC vendor application intake (Wave 4 step 3).
 *
 * NO @UseGuards(JwtAuthGuard) — deliberately, and this is the only controller
 * in the app without one. The prototype's screen is a public form that says so
 * in its own alert copy, and the status lookup cannot require a login because
 * the applicant does not have one.
 *
 * What replaces the missing guard is stated in the service: the reference is
 * sequential and therefore guessable, so the status lookup additionally requires
 * the applicant's own email, and returns a subset of the row. Everything that
 * makes this endpoint safe is in OnboardingService's docstrings — read those
 * before adding a field to either response.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  /** Form copy, field metadata and the real category vocabulary. */
  @Get('form')
  form() {
    return this.svc.form();
  }

  /** Anonymous submission. Returns the DATABASE's reference. */
  @Post('applications')
  async submit(@Body() body: VendorApplicationDto) {
    return this.svc.submit(body);
  }

  /** The applicant's own status lookup. `?email=` is required — see the service. */
  @Get('applications/:reference')
  async status(
    @Param('reference') reference: string,
    @Query() q: StatusQueryDto,
  ) {
    return this.svc.status(reference, q?.email);
  }
}

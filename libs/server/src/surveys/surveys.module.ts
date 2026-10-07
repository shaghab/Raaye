import { Module } from '@nestjs/common';
import { AudienceService } from './audience.service';
import { LaunchService } from './launch.service';
import { ActivateSurveyHandler, CloseSurveyHandler } from './lifecycle.handlers';
import { SurveysService } from './surveys.service';

@Module({
  providers: [AudienceService, SurveysService, LaunchService, ActivateSurveyHandler, CloseSurveyHandler],
  exports: [AudienceService, SurveysService, LaunchService, ActivateSurveyHandler, CloseSurveyHandler],
})
export class SurveysModule {}

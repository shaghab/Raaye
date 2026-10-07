import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthConfigDto } from '@raaye/contracts';
import { APP_CONFIG, Public, type AppConfig } from '@raaye/server';

/** Public, non-secret settings the browser needs to initialize Firebase Authentication. */
@ApiTags('auth')
@Controller('auth')
export class AuthConfigController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get('config')
  authConfig(): AuthConfigDto {
    const emulator = this.config.AUTH_MODE === 'emulator';
    return {
      authMode: this.config.AUTH_MODE,
      projectId: this.config.FIREBASE_PROJECT_ID,
      apiKey: this.config.PUBLIC_FIREBASE_API_KEY ?? (emulator ? 'demo-api-key' : ''),
      emulatorUrl: emulator ? (this.config.PUBLIC_AUTH_EMULATOR_URL ?? `http://${this.config.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`) : null,
      messagingMode: this.config.MESSAGING_MODE,
      simulatorEnabled: this.config.simulatorEnabled,
      appEnv: this.config.APP_ENV,
    };
  }
}

import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, loadConfig, type AppConfig } from './env';

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config?: AppConfig): DynamicModule {
    const value = config ?? loadConfig();
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: value }],
      exports: [APP_CONFIG],
    };
  }
}

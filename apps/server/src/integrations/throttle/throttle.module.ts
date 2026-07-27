import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { EnvironmentService } from '../environment/environment.service';
import { EnvironmentModule } from '../environment/environment.module';
import { parseRedisUrl } from '../../common/helpers';
import { AUTH_THROTTLER, AI_CHAT_THROTTLER, GALLERY_THROTTLER } from './throttler-names';
import Redis from 'ioredis';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [EnvironmentModule],
      useFactory: (environmentService: EnvironmentService) => {
        const redisConfig = parseRedisUrl(environmentService.getRedisUrl());

        return {
          throttlers: [
            { name: AUTH_THROTTLER, ttl: 60_000, limit: 10 },
            { name: AI_CHAT_THROTTLER, ttl: 60_000, limit: 25 },
            // Default (150/min) is overridden per-workspace via
            // GalleryThrottlerGuard, which reads
            // workspace.settings.gallery.rateLimitPerMinute — see Settings
            // > Gallery. This static value is only the fallback used when
            // that setting isn't configured, or when workspaceId can't be
            // resolved (fail-safe, never fail-open).
            { name: GALLERY_THROTTLER, ttl: 60_000, limit: 150 },
          ],
          errorMessage: 'Too many requests',
          storage: new ThrottlerStorageRedisService(
            new Redis({
              host: redisConfig.host,
              port: redisConfig.port,
              password: redisConfig.password,
              db: redisConfig.db,
              family: redisConfig.family,
              keyPrefix: 'throttle:',
            }),
          ),
        };
      },
      inject: [EnvironmentService],
    }),
  ],
})
export class ThrottleModule {}

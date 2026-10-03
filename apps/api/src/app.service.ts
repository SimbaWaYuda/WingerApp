import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo() {
    return {
      name: 'Winger API',
      version: '0.1.0',
      docs: [
        'GET /health',
        'POST /auth/login',
        'POST /auth/register',
        'GET /auth/me',
        'GET /products',
        'GET /products/:id',
        'POST /sync/events',
        'GET /sync/events',
      ],
    };
  }

  getHealth() {
    return {
      status: 'ok',
      service: 'winger-api',
      timestamp: new Date().toISOString(),
    };
  }
}

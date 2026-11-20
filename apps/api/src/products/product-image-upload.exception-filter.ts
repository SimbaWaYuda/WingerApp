import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { MulterError } from 'multer';

/**
 * Multer 2.5 reports an extra file on a counted field as LIMIT_UNEXPECTED_FILE
 * ("Unexpected file field"). NestJS 10 still matches the older message
 * "Unexpected field", so the error would otherwise leave this route as HTTP 500.
 * Attached only to POST products/:id/images.
 */
@Catch(MulterError)
export class ProductImageUploadExceptionFilter extends BaseExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost): void {
    if (exception.code === 'LIMIT_UNEXPECTED_FILE') {
      super.catch(new BadRequestException(exception.message), host);
      return;
    }
    super.catch(exception, host);
  }
}

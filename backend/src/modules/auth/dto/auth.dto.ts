/**
 * DTOs for the Auth module.
 *
 * @module auth.dto
 */

import { IsEmail, IsIn, IsOptional, IsString, IsNotEmpty, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(72) // bcryptjs input cap
  password: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsIn(['admin', 'delivery-lead', 'content', 'technical', 'outreach', 'sales'])
  @IsOptional()
  /** Admin-only after the first account. First account becomes admin regardless. */
  role?: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
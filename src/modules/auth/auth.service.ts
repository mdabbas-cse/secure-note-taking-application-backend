import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import { User } from '../../models/User.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { signAccessToken } from '../../utils/jwt.js';
import { toUserDTO, type UserDTO } from '../users/user.dto.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

const INVALID_CREDENTIALS = 'Invalid email or password';

let dummyHash: Promise<string> | undefined;
/**
 * Hash compared against when the email does not exist, so "unknown email" and
 * "wrong password" take the same time and cannot be told apart.
 */
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash('dummy-password-for-timing-equalisation', env.bcryptSaltRounds);
  return dummyHash;
}

export interface AuthResult {
  user: UserDTO;
  accessToken: string;
}

function issueToken(user: UserDTO): AuthResult {
  return { user, accessToken: signAccessToken({ userId: user.id, role: user.role }) };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  // Role is hard-coded: self-registration can only ever create a normal user.
  // Duplicate emails surface as E11000 from the unique index -> 409 in errorHandler.
  const user = await User.create({ ...input, role: 'user' });
  return issueToken(toUserDTO(user));
}

export async function login({ email, password }: LoginInput): Promise<AuthResult> {
  // Uses the unique email_1 index; the hash is opted in only for this query.
  const user = await User.findOne({ email }).select('+password');

  if (!user) {
    await bcrypt.compare(password, await getDummyHash());
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  const passwordMatches = await user.comparePassword(password);
  if (!passwordMatches) throw ApiError.unauthorized(INVALID_CREDENTIALS);

  return issueToken(toUserDTO(user));
}

export async function getCurrentUser(userId: string): Promise<UserDTO> {
  const user = await User.findById(userId).lean();
  // Token is valid but the account was deleted: treat as unauthenticated.
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  return toUserDTO(user);
}

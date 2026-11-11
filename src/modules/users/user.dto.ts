import type { Types } from 'mongoose';
import type { IUser, Role } from '../../models/User.model.js';

/** Public user representation. Built from an allow-list, so the hash cannot leak. */
export interface UserDTO {
  id: string;
  name: string;
  email: string;
  role: Role;
  interests: string[];
  createdAt: Date;
  updatedAt: Date;
}

type UserLike = Omit<IUser, 'password'> & { _id: Types.ObjectId };

export function toUserDTO(user: UserLike): UserDTO {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    interests: [...user.interests],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

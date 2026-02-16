import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.model.js';

// Load environment variables
dotenv.config();

const createSuperAdmin = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/washq_saas');
    console.log('MongoDB connected successfully');

    const email = 'washq@gmail.com';
    const password = 'Pass@123#';

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('User already exists with this email. Updating password...');
      
      // Update password (will be hashed by pre-save hook)
      existingUser.password = password;
      await existingUser.save();
      
      console.log('Password updated successfully!');
      console.log('Email:', existingUser.email);
      console.log('Password:', password);
      console.log('Role:', existingUser.role);
      await mongoose.connection.close();
      process.exit(0);
    }

    // Create super admin user
    // Note: Password will be automatically hashed by the User model's pre-save hook
    const user = await User.create({
      email,
      password: password, // Plain password - will be hashed by pre-save hook
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      businessId: null
    });

    console.log('Super Admin created successfully!');
    console.log('Email:', user.email);
    console.log('Password:', password);
    console.log('Role:', user.role);
    console.log('Status:', user.status);

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Error creating super admin:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

createSuperAdmin();

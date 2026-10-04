import { PrismaClient, StockStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const suppliers = [
  { id: 's-kijani', name: 'Kijani Tech', verificationStatus: 'APPROVED' },
  { id: 's-atlas', name: 'Atlas Home', verificationStatus: 'APPROVED' },
  { id: 's-metals', name: 'Metals Outdoor', verificationStatus: 'UNVERIFIED' },
  // Same catalogue SKUs as Kijani at alternate prices — for multi-supplier compare.
  {
    id: 's-savanna',
    name: 'Savanna Electronics',
    verificationStatus: 'APPROVED',
  },
];

const products = [
  {
    id: 'p-aeropulse',
    name: 'AeroPulse ANC Headphones',
    brand: 'AeroPulse',
    supplierId: 's-kijani',
    supplierName: 'Kijani Tech',
    price: 249,
    previousPrice: 279,
    rating: 4.8,
    imageUrl:
      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
    category: 'Audio',
    model: 'AP700',
    color: 'Graphite',
    size: 'Standard',
    battery: '36h',
    weight: '248g',
    description:
      'Quiet cabin-ready ANC headphones with multi-point Bluetooth and USB-C fast charge.',
    stock: 42,
    stockStatus: StockStatus.IN_STOCK,
  },
  {
    id: 'p-terraform',
    name: 'Terraform M6 Trail Pack',
    brand: 'Terraform',
    supplierId: 's-metals',
    supplierName: 'Metals Outdoor',
    price: 129,
    rating: 4.6,
    imageUrl:
      'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800',
    category: 'Bags',
    model: 'M6',
    color: 'Forest',
    size: '28L',
    battery: '—',
    weight: '890g',
    description: 'Weather-ready daypack with laptop sleeve and hydration port.',
    stock: 18,
    stockStatus: StockStatus.LOW_STOCK,
  },
  {
    id: 'p-lumivolt',
    name: 'Lumivolt Desk Lamp',
    brand: 'Lumivolt',
    supplierId: 's-atlas',
    supplierName: 'Atlas Home',
    price: 89,
    previousPrice: 109,
    rating: 4.4,
    imageUrl:
      'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800',
    category: 'Home',
    model: 'LV-Desk',
    color: 'Matte White',
    size: 'Standard',
    battery: '—',
    weight: '1.1kg',
    description: 'Adjustable desk lamp with warm/cool modes for focused work.',
    stock: 64,
    stockStatus: StockStatus.IN_STOCK,
  },
  {
    id: 'p-pulsewatch',
    name: 'Pulse Watch Pro',
    brand: 'Pulse',
    supplierId: 's-kijani',
    supplierName: 'Kijani Tech',
    price: 319,
    rating: 4.7,
    imageUrl:
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800',
    category: 'Wearables',
    model: 'PW-Pro',
    color: 'Midnight',
    size: '42mm',
    battery: '7d',
    weight: '38g',
    description: 'Training-ready smartwatch with GPS and recovery insights.',
    stock: 27,
    stockStatus: StockStatus.IN_STOCK,
  },
  {
    id: 'p-soundfold',
    name: 'SoundFold Mini Speaker',
    brand: 'SoundFold',
    supplierId: 's-kijani',
    supplierName: 'Kijani Tech',
    price: 79,
    rating: 4.3,
    imageUrl:
      'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800',
    category: 'Audio',
    model: 'SF-Mini',
    color: 'Sand',
    size: 'Compact',
    battery: '12h',
    weight: '310g',
    description: 'Portable Bluetooth speaker with punchy midrange for travel.',
    stock: 51,
    stockStatus: StockStatus.IN_STOCK,
  },
  {
    id: 'p-northline',
    name: 'Northline Softshell Jacket',
    brand: 'Northline',
    supplierId: 's-metals',
    supplierName: 'Metals Outdoor',
    price: 168,
    rating: 4.5,
    imageUrl:
      'https://images.unsplash.com/photo-1544022613-e87ca75a784a?w=800',
    category: 'Apparel',
    model: 'NL-Soft',
    color: 'Slate',
    size: 'M',
    battery: '—',
    weight: '420g',
    description: 'Wind-resistant softshell for city-to-trail days.',
    stock: 33,
    stockStatus: StockStatus.IN_STOCK,
  },
  // Savanna Electronics — same models as Kijani, different selling prices.
  {
    id: 'p-aeropulse-savanna',
    name: 'AeroPulse ANC Headphones',
    brand: 'AeroPulse',
    supplierId: 's-savanna',
    supplierName: 'Savanna Electronics',
    price: 229,
    previousPrice: 259,
    rating: 4.6,
    imageUrl:
      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
    category: 'Audio',
    model: 'AP700',
    color: 'Graphite',
    size: 'Standard',
    battery: '36h',
    weight: '248g',
    description:
      'Quiet cabin-ready ANC headphones with multi-point Bluetooth and USB-C fast charge.',
    stock: 35,
    stockStatus: StockStatus.IN_STOCK,
  },
  {
    id: 'p-pulsewatch-savanna',
    name: 'Pulse Watch Pro',
    brand: 'Pulse',
    supplierId: 's-savanna',
    supplierName: 'Savanna Electronics',
    price: 299,
    previousPrice: 329,
    rating: 4.5,
    imageUrl:
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800',
    category: 'Wearables',
    model: 'PW-Pro',
    color: 'Midnight',
    size: '42mm',
    battery: '7d',
    weight: '38g',
    description: 'Training-ready smartwatch with GPS and recovery insights.',
    stock: 22,
    stockStatus: StockStatus.IN_STOCK,
  },
  {
    id: 'p-soundfold-savanna',
    name: 'SoundFold Mini Speaker',
    brand: 'SoundFold',
    supplierId: 's-savanna',
    supplierName: 'Savanna Electronics',
    price: 69,
    rating: 4.2,
    imageUrl:
      'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800',
    category: 'Audio',
    model: 'SF-Mini',
    color: 'Sand',
    size: 'Compact',
    battery: '12h',
    weight: '310g',
    description: 'Portable Bluetooth speaker with punchy midrange for travel.',
    stock: 48,
    stockStatus: StockStatus.IN_STOCK,
  },
];

async function main() {
  for (const supplier of suppliers) {
    await prisma.supplier.upsert({
      where: { id: supplier.id },
      update: {
        name: supplier.name,
        verificationStatus: supplier.verificationStatus,
      },
      create: {
        id: supplier.id,
        name: supplier.name,
        verificationStatus: supplier.verificationStatus,
      },
    });
  }

  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        name: product.name,
        brand: product.brand,
        supplierId: product.supplierId,
        supplierName: product.supplierName,
        price: product.price,
        previousPrice: product.previousPrice,
        rating: product.rating,
        imageUrl: product.imageUrl,
        category: product.category,
        model: product.model,
        color: product.color,
        size: product.size,
        battery: product.battery,
        weight: product.weight,
        description: product.description,
        stock: product.stock,
        stockStatus: product.stockStatus,
      },
      create: product,
    });
  }

  const passwordHash = await bcrypt.hash('demo1234', 10);
  const users = [
    {
      email: 'amina.mwangi@example.com',
      name: 'Amina Mwangi',
      role: UserRole.CUSTOMER,
      supplierId: null as string | null,
    },
    {
      email: 'supplier@kijani.example',
      name: 'John Doe',
      role: UserRole.SUPPLIER,
      supplierId: 's-kijani',
    },
    {
      email: 'supplier@savanna.example',
      name: 'Asha Otieno',
      role: UserRole.SUPPLIER,
      supplierId: 's-savanna',
    },
    {
      email: 'admin@winger.example',
      name: 'Winger Admin',
      role: UserRole.ADMIN,
      supplierId: null as string | null,
    },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        supplierId: user.supplierId,
        passwordHash,
      },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        supplierId: user.supplierId,
        passwordHash,
      },
    });
  }

  console.log(
    `Seeded ${suppliers.length} suppliers, ${products.length} products, ${users.length} users`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

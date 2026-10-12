/**
 * Made-up demo data: a plastic-goods wholesaler's catalogue and customers.
 * Names, phone numbers and businesses are invented.
 */

export interface DemoProduct {
  item_code: string;
  name: string;
  category: string;
  unit: 'pcs' | 'dozen' | 'set' | 'carton';
  sizes: string[];
  colors: string[];
  /** Rupees. */
  price: number;
  /** Relative sales volume. */
  popularity: number;
}

const COLORS = {
  basic: ['Red', 'Blue', 'Green', 'Black'],
  bright: ['Red', 'Blue', 'Yellow', 'Pink'],
  home: ['White', 'Grey', 'Beige'],
  dark: ['Black', 'Brown', 'Green'],
  clear: ['Clear', 'Blue'],
};

interface Family {
  category: string;
  prefix: string;
  unit: DemoProduct['unit'];
  items: [name: string, sizes: string[], colors: string[], price: number, popularity: number][];
}

const FAMILIES: Family[] = [
  {
    category: 'Buckets',
    prefix: 'BK',
    unit: 'pcs',
    items: [
      ['Bucket with lid', ['10L', '15L'], COLORS.basic, 650, 9],
      ['Heavy bucket', ['20L', '25L'], COLORS.basic, 1050, 6],
      ['Bucket with tap', ['20L'], COLORS.bright, 1450, 3],
      ['Mop bucket', ['12L'], COLORS.bright, 780, 3],
      ['Paint bucket', ['5L', '10L'], COLORS.home, 420, 4],
    ],
  },
  {
    category: 'Tubs',
    prefix: 'TB',
    unit: 'pcs',
    items: [
      ['Round tub', ['30L', '50L'], COLORS.basic, 890, 6],
      ['Washing tub', ['60L', '80L'], COLORS.basic, 1350, 4],
      ['Baby bath tub', ['Standard'], ['Pink', 'Blue', 'Yellow'], 1650, 3],
      ['Oval tub', ['40L'], COLORS.bright, 990, 3],
      ['Mixing tub', ['45L'], COLORS.dark, 760, 2],
    ],
  },
  {
    category: 'Chairs',
    prefix: 'CH',
    unit: 'pcs',
    items: [
      ['Armless chair', ['Standard'], ['White', 'Green', 'Blue', 'Brown'], 1750, 8],
      ['Arm chair', ['Standard'], ['White', 'Green', 'Brown'], 2350, 7],
      ['Kids chair', ['Small'], COLORS.bright, 850, 4],
      ['Stool', ['Low', 'High'], COLORS.basic, 690, 5],
      ['Executive chair', ['Standard'], ['Black', 'Brown'], 3950, 2],
    ],
  },
  {
    category: 'Tables',
    prefix: 'TA',
    unit: 'pcs',
    items: [
      ['Dining table', ['4-seat', '6-seat'], ['White', 'Brown'], 6450, 3],
      ['Center table', ['Standard'], ['White', 'Brown', 'Black'], 2950, 2],
      ['Kids table', ['Small'], COLORS.bright, 1850, 2],
      ['Folding table', ['Standard'], ['White', 'Grey'], 4250, 2],
      ['Side table', ['Standard'], COLORS.home, 1490, 2],
    ],
  },
  {
    category: 'Crates',
    prefix: 'CR',
    unit: 'pcs',
    items: [
      ['Vegetable crate', ['Medium', 'Large'], ['Green', 'Blue', 'Red'], 980, 7],
      ['Bottle crate', ['24 bottles'], ['Red', 'Blue'], 1250, 3],
      ['Bread crate', ['Standard'], ['Blue', 'Grey'], 1150, 3],
      ['Fish crate', ['Large'], ['Blue', 'White'], 1390, 2],
      ['Folding crate', ['Medium'], ['Grey', 'Green'], 1690, 2],
    ],
  },
  {
    category: 'Baskets',
    prefix: 'BS',
    unit: 'pcs',
    items: [
      ['Laundry basket', ['Medium', 'Large'], COLORS.home, 720, 5],
      ['Fruit basket', ['Small', 'Medium'], COLORS.bright, 290, 6],
      ['Shopping basket', ['Standard'], COLORS.basic, 540, 4],
      ['Waste paper basket', ['Small'], COLORS.bright, 240, 5],
      ['Bread basket', ['Standard'], COLORS.home, 330, 2],
    ],
  },
  {
    category: 'Jugs & bottles',
    prefix: 'JG',
    unit: 'pcs',
    items: [
      ['Water jug', ['1.5L', '2.5L'], COLORS.clear, 260, 8],
      ['Water cooler', ['10L', '16L'], ['Blue', 'Red', 'Green'], 1950, 5],
      ['Water bottle', ['500ml', '1L'], COLORS.bright, 190, 7],
      ['Oil can', ['5L'], ['White', 'Yellow'], 340, 3],
      ['Thermos jug', ['1.9L'], ['Blue', 'Red'], 1150, 3],
    ],
  },
  {
    category: 'Storage',
    prefix: 'ST',
    unit: 'pcs',
    items: [
      ['Storage box', ['Small', 'Medium', 'Large'], COLORS.clear, 690, 6],
      ['Drawer unit', ['3-drawer', '4-drawer'], COLORS.home, 4850, 2],
      ['Rice container', ['10kg', '20kg'], COLORS.home, 980, 4],
      ['Shoe rack', ['3-tier', '5-tier'], ['Black', 'Grey'], 2250, 2],
      ['Toy box', ['Large'], COLORS.bright, 1290, 2],
    ],
  },
  {
    category: 'Dustbins',
    prefix: 'DB',
    unit: 'pcs',
    items: [
      ['Pedal dustbin', ['8L', '15L'], ['Grey', 'White', 'Black'], 690, 5],
      ['Swing dustbin', ['25L', '45L'], ['Grey', 'Blue'], 890, 4],
      ['Wheeled bin', ['120L'], ['Green', 'Grey'], 6950, 1],
      ['Kitchen bin', ['10L'], COLORS.home, 450, 4],
      ['Office bin', ['Small'], ['Black', 'Grey'], 220, 4],
    ],
  },
  {
    category: 'Kitchenware',
    prefix: 'KW',
    unit: 'dozen',
    items: [
      ['Plates', ['Quarter', 'Full'], COLORS.home, 960, 6],
      ['Glasses', ['Standard'], COLORS.clear, 540, 7],
      ['Bowls', ['Small', 'Large'], COLORS.bright, 720, 5],
      ['Spoons', ['Tea', 'Table'], COLORS.home, 180, 6],
      ['Lunch box', ['2-part', '3-part'], ['Blue', 'Pink', 'Green'], 2280, 3],
    ],
  },
  {
    category: 'Mugs & cups',
    prefix: 'MG',
    unit: 'dozen',
    items: [
      ['Tea cups', ['Standard'], COLORS.home, 480, 6],
      ['Bath mug', ['1L', '1.5L'], COLORS.bright, 840, 6],
      ['Measuring cup', ['Set'], COLORS.clear, 360, 2],
      ['Kids mug', ['Small'], COLORS.bright, 600, 3],
      ['Travel mug', ['400ml'], ['Black', 'Blue'], 1560, 2],
    ],
  },
  {
    category: 'Garden & outdoor',
    prefix: 'GD',
    unit: 'pcs',
    items: [
      ['Flower pot', ['6 in', '10 in', '14 in'], ['Brown', 'Black', 'White'], 240, 6],
      ['Watering can', ['5L'], ['Green', 'Red'], 520, 3],
      ['Garden pipe', ['15m', '30m'], ['Green', 'Yellow'], 1650, 3],
      ['Planter box', ['Long'], ['Brown', 'Black'], 980, 2],
      ['Outdoor mat', ['4x6', '5x8'], ['Green', 'Grey'], 1450, 2],
    ],
  },
];

export const DEMO_PRODUCTS: DemoProduct[] = FAMILIES.flatMap((f) =>
  f.items.map(([name, sizes, colors, price, popularity], i) => ({
    item_code: `${f.prefix}-${101 + i}`,
    name,
    category: f.category,
    unit: f.unit,
    sizes,
    colors,
    price,
    popularity,
  })),
);

/** How a customer pays (drives receipts, overdue, aging and bad debt in the demo). */
export type PayHabit = 'prompt' | 'late' | 'partial' | 'chronic' | 'stopped' | 'bad';

export interface DemoCustomer {
  name: string;
  business_name: string;
  type: 'wholesaler' | 'retailer';
  city: string;
  area: string;
  terms: number;
  /** Rupees; 0 = no limit. */
  credit_limit: number;
  habit: PayHabit;
  /** Month (0-based from the start) the customer first buys; later ones are "new customers". */
  joins: number;
  /** Rupees owed from before ShopLedger (opening balance), 0 if none. */
  opening: number;
  /** Relative order size. */
  size: number;
}

const C = (
  name: string,
  business_name: string,
  type: DemoCustomer['type'],
  city: string,
  area: string,
  terms: number,
  credit_limit: number,
  habit: PayHabit,
  joins = 0,
  opening = 0,
  size = 1,
): DemoCustomer => ({ name, business_name, type, city, area, terms, credit_limit, habit, joins, opening, size });

export const DEMO_CUSTOMERS: DemoCustomer[] = [
  C('Haji Abdul Razzaq', 'Razzaq Plastic House', 'wholesaler', 'Karachi', 'Jodia Bazaar', 60, 3_000_000, 'prompt', 0, 0, 2.2),
  C('Muhammad Asif', 'Asif Traders', 'wholesaler', 'Karachi', 'Saddar', 45, 2_000_000, 'late', 0, 350_000, 1.6),
  C('Shahid Mehmood', 'Mehmood & Sons', 'wholesaler', 'Hyderabad', 'Resham Bazaar', 60, 2_500_000, 'prompt', 0, 0, 1.8),
  C('Rana Tariq', 'Tariq General Store', 'retailer', 'Karachi', 'Gulshan-e-Iqbal', 15, 200_000, 'prompt', 0, 0, 0.6),
  C('Imtiaz Ahmed', 'Imtiaz Crockery', 'wholesaler', 'Sukkur', 'Shikarpur Road', 60, 1_500_000, 'chronic', 0, 420_000, 1.2),
  C('Faisal Qureshi', 'Qureshi Home Centre', 'retailer', 'Karachi', 'Nazimabad', 30, 300_000, 'late', 0, 0, 0.7),
  C('Naveed Akhtar', 'Akhtar Plastic Mart', 'wholesaler', 'Multan', 'Hussain Agahi', 45, 2_000_000, 'prompt', 0, 0, 1.5),
  C('Zubair Khan', 'Khan Brothers', 'wholesaler', 'Quetta', 'Liaquat Bazaar', 90, 2_500_000, 'late', 0, 0, 1.7),
  C('Sajid Hussain', 'Sajid Store', 'retailer', 'Karachi', 'Korangi', 15, 150_000, 'partial', 0, 0, 0.5),
  C('Kamran Siddiqui', 'Siddiqui Traders', 'wholesaler', 'Larkana', 'Resham Gali', 60, 1_200_000, 'bad', 0, 0, 1.0),
  C('Arshad Mahmood', 'Arshad Kitchen Gallery', 'retailer', 'Lahore', 'Shah Alam Market', 30, 400_000, 'prompt', 0, 0, 0.8),
  C('Waseem Abbasi', 'Abbasi Plastic Centre', 'wholesaler', 'Rawalpindi', 'Raja Bazaar', 45, 1_800_000, 'partial', 0, 0, 1.3),
  C('Tahir Javed', 'Javed Super Store', 'retailer', 'Karachi', 'DHA Phase 6', 15, 0, 'prompt', 0, 0, 0.6),
  C('Nadeem Baig', 'Baig Enterprises', 'wholesaler', 'Faisalabad', 'Kotwali Road', 60, 2_000_000, 'late', 0, 280_000, 1.4),
  C('Asad Ullah', 'Asad Household', 'retailer', 'Hyderabad', 'Latifabad', 30, 250_000, 'chronic', 0, 0, 0.5),
  C('Rizwan Shaikh', 'Shaikh Trading Co', 'wholesaler', 'Karachi', 'Lea Market', 45, 2_200_000, 'prompt', 0, 0, 1.9),
  C('Ghulam Mustafa', 'Mustafa Bartan Store', 'retailer', 'Nawabshah', 'Station Road', 30, 200_000, 'late', 0, 0, 0.5),
  C('Anwar Hussain', 'Anwar Plastic Works', 'wholesaler', 'Mirpurkhas', 'Main Bazaar', 60, 1_000_000, 'stopped', 0, 0, 0.9),
  C('Bilal Ahmed', 'Bilal Crockery House', 'retailer', 'Karachi', 'Malir', 15, 150_000, 'prompt', 0, 0, 0.5),
  C('Saeed Akram', 'Akram Wholesale', 'wholesaler', 'Peshawar', 'Qissa Khwani', 90, 2_000_000, 'partial', 0, 0, 1.3),
  C('Junaid Iqbal', 'Iqbal Home Store', 'retailer', 'Lahore', 'Anarkali', 30, 300_000, 'prompt', 0, 0, 0.7),
  C('Mushtaq Ali', 'Ali Plastic Depot', 'wholesaler', 'Sukkur', 'Frere Road', 45, 1_500_000, 'late', 0, 0, 1.1),
  C('Farhan Malik', 'Malik Utensils', 'retailer', 'Karachi', 'Orangi Town', 15, 100_000, 'chronic', 0, 0, 0.4),
  C('Usman Ghani', 'Ghani Traders', 'wholesaler', 'Hyderabad', 'Tilak Incline', 60, 1_800_000, 'prompt', 0, 0, 1.4),
  C('Adnan Raza', 'Raza Departmental Store', 'retailer', 'Karachi', 'North Karachi', 30, 250_000, 'late', 0, 0, 0.6),
  C('Hafiz Nadeem', 'Nadeem Plastic Bazaar', 'wholesaler', 'Larkana', 'Pakistan Chowk', 60, 1_200_000, 'bad', 0, 150_000, 0.9),
  C('Salman Butt', 'Butt Household Centre', 'retailer', 'Gujranwala', 'GT Road', 30, 300_000, 'prompt', 0, 0, 0.6),
  C('Kashif Rehman', 'Rehman & Co', 'wholesaler', 'Karachi', 'Bolton Market', 30, 2_500_000, 'prompt', 0, 0, 2.0),
  C('Aamir Sohail', 'Sohail Kitchen Mart', 'retailer', 'Thatta', 'Makli Road', 30, 150_000, 'partial', 0, 0, 0.4),
  C('Majid Khan', 'Khan Plastic Agency', 'wholesaler', 'Quetta', 'Masjid Road', 90, 2_000_000, 'stopped', 0, 0, 1.0),
  // New customers during the period
  C('Shoaib Akhtar', 'Akhtar Home Needs', 'retailer', 'Karachi', 'Gulistan-e-Johar', 15, 150_000, 'prompt', 4),
  C('Danish Ali', 'Danish Plastic Point', 'wholesaler', 'Hyderabad', 'Qasimabad', 45, 1_500_000, 'late', 6),
  C('Owais Qadri', 'Qadri Crockery', 'retailer', 'Karachi', 'Shah Faisal Colony', 30, 200_000, 'chronic', 7),
  C('Yasir Hameed', 'Hameed Distributors', 'wholesaler', 'Multan', 'Chowk Bazaar', 60, 2_000_000, 'prompt', 9),
  C('Noman Aslam', 'Aslam Store', 'retailer', 'Sukkur', 'Military Road', 30, 150_000, 'late', 11),
  C('Rashid Latif', 'Latif Wholesale Mart', 'wholesaler', 'Karachi', 'Jodia Bazaar', 45, 2_000_000, 'partial', 12),
  C('Sohail Tanvir', 'Tanvir Utensil House', 'retailer', 'Lahore', 'Ichhra', 15, 200_000, 'prompt', 13),
  C('Moin Khan', 'Moin Plastic Centre', 'wholesaler', 'Faisalabad', 'Jhang Bazaar', 60, 1_500_000, 'late', 14),
  C('Hasan Raza', 'Raza Home Collection', 'retailer', 'Karachi', 'Clifton', 30, 300_000, 'prompt', 15),
  C('Wahab Riaz', 'Riaz Trading', 'wholesaler', 'Peshawar', 'Karkhano Market', 60, 1_500_000, 'chronic', 16),
];

export const RETURN_REASONS = ['Damaged in transport', 'Wrong colour sent', 'Customer ordered too many', 'Cracked on arrival', 'Wrong size sent'];
export const BANKS = ['HBL', 'MCB', 'UBL', 'Meezan Bank', 'Bank Alfalah', 'Allied Bank'];

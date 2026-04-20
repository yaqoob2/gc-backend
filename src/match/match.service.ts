import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Fuse from 'fuse.js';
import { Master } from './master.entity';

@Injectable()
export class MatchService {
    constructor(
        @InjectRepository(Master)
        private readonly masterRepo: Repository<Master>,
    ) { }

    normalize(value: string): string {
        return (value || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^a-z0-9]/g, '')
            .trim();
    }

    toDisplayScore(rawScore: number | null): number | null {
        if (rawScore === null || rawScore === undefined) return null;
        return Number((rawScore * 10).toFixed(2));
    }

    getUniqueVendors(productName: string, products: any[]): string[] {
        const normalizedTarget = this.normalize(productName);

        const vendors = products
            .filter((p) => this.normalize(p.productName) === normalizedTarget)
            .map((p) => p.vendorName)
            .filter((v) => v && String(v).trim() !== '');

        return [...new Set(vendors)];
    }

    async matchCsvRows(csvRows: any[]) {
        const products = await this.masterRepo.find();

        const normalizedProducts = products.map((p) => ({
            ...p,
            normalizedName: this.normalize(p.productName),
            normalizedCompany: this.normalize(p.company),
        }));

        const productFuse = new Fuse(normalizedProducts, {
            keys: ['normalizedName'],
            threshold: 0.6,
            includeScore: true,
        });

        const companyFuse = new Fuse(normalizedProducts, {
            keys: ['normalizedCompany'],
            threshold: 0.6,
            includeScore: true,
        });

        const results = csvRows
            .map((row) => {
                const csvName =
                    row.Particulars || row.product_name || row.name || row.product || '';

                if (!csvName || csvName.trim() === '') {
                    return null;
                }

                const csvCompany = row.Company || row.company || '';
                const sNo = row.SNo ?? null;
                const packing = row.Packing ?? '';
                const qty = row['Qty.'] ?? row.Qty ?? '';
                const free = row.Free ?? '';
                const rate = row.Rate ?? '';
                const amount = row.Amount ?? '';

                const normalizedCsvName = this.normalize(csvName);
                const normalizedCsvCompany = this.normalize(csvCompany);

                let matchedProduct: string | null = null;
                let matchedId: number | null = null;
                let productScore: number | null = null;
                let companyScore: number | null = null;
                let uniqueVendors: string[] = [];

                const exactMatch = normalizedProducts.find(
                    (p) => p.normalizedName === normalizedCsvName,
                );

                if (exactMatch) {
                    matchedProduct = exactMatch.productName;
                    matchedId = exactMatch.id;
                    productScore = 0;
                    uniqueVendors = this.getUniqueVendors(
                        exactMatch.productName,
                        normalizedProducts,
                    );
                } else {
                    const productResult = productFuse.search(normalizedCsvName, {
                        limit: 1,
                    });

                    if (productResult.length > 0) {
                        const best = productResult[0];
                        matchedProduct = best.item.productName;
                        matchedId = best.item.id;
                        productScore = this.toDisplayScore(best.score ?? null);
                        uniqueVendors = this.getUniqueVendors(
                            best.item.productName,
                            normalizedProducts,
                        );
                    }
                }

                // YES condition
                if (productScore !== null && productScore >= 0 && productScore <= 4) {
                    return {
                        SNo: sNo,
                        Particulars: csvName,
                        Packing: packing,
                        Company: csvCompany,
                        'Qty.': qty,
                        Free: free,
                        Rate: rate,
                        Amount: amount,
                        matchedProduct,
                        matchedId,
                        score: productScore,
                        companyScore: null,
                        decision: 'yes',
                        uniqueVendors,
                        status: exactMatch ? 'Exact product match' : 'Product fuzzy match',
                    };
                }

                // COMPANY COMPARISON for score > 4 or null
                if (normalizedCsvCompany) {
                    const companyResult = companyFuse.search(normalizedCsvCompany, {
                        limit: 1,
                    });

                    if (companyResult.length > 0) {
                        companyScore = this.toDisplayScore(companyResult[0].score ?? null);

                        // if no product selected yet, use company-matched row
                        if (!matchedProduct) {
                            matchedProduct = companyResult[0].item.productName;
                            matchedId = companyResult[0].item.id;
                            uniqueVendors = this.getUniqueVendors(
                                companyResult[0].item.productName,
                                normalizedProducts,
                            );
                        }
                    }
                }

                // MAYBE for company score 0<=x<=3
                // and also MAYBE for everything else, because there is no "no"
                return {
                    SNo: sNo,
                    Particulars: csvName,
                    Packing: packing,
                    Company: csvCompany,
                    'Qty.': qty,
                    Free: free,
                    Rate: rate,
                    Amount: amount,
                    matchedProduct,
                    matchedId,
                    score: productScore,
                    companyScore,
                    decision: 'maybe',
                    uniqueVendors,
                    status:
                        companyScore !== null && companyScore >= 0 && companyScore <= 3
                            ? 'Company-to-company match'
                            : 'Fallback maybe',
                };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

        return results;
    }
}
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

    normalize(value: any): string {
        return String(value || '')
            .toLowerCase()
            .replace(/\b(syrup|syp)\b/g, 'syp')
            .replace(/\b(capsule|capsules|cap)\b/g, 'cap')
            .replace(/\b(tablet|tablets|tab)\b/g, 'tab')
            .replace(/\b(drop|drops)\b/g, 'drop')
            .replace(/\b(injection|inj)\b/g, 'inj')
            .replace(/\b(cream)\b/g, 'crm')
            .replace(/\b(ointment|oint)\b/g, 'oint')
            .replace(/\b(lotion)\b/g, 'lot')
            .replace(/\b(suspension|susp)\b/g, 'susp')
            .replace(/\b(solution|soln|sol)\b/g, 'sol')
            .replace(/\b(laboratories|laboratory|labs|lab)\b/g, 'lab')
            .replace(/\b(pharmaceuticals|pharma)\b/g, 'pharma')
            .replace(/(\d+)\s*(ml|mg|gm|g|mcg)/g, '$1$2')
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

    removePackingFromName(name: any, packing: any): string {
        const strName = String(name || '');
        const strPacking = String(packing || '');

        if (!strName) return '';
        if (!strPacking) return strName;

        let cleanedName = strName;
        const normalizedPacking = this.normalize(strPacking);

        if (!normalizedPacking) return cleanedName;

        const possiblePackingForms = Array.from(
            new Set(
                [
                    strPacking,
                    strPacking.replace(/\s+/g, ''),
                    strPacking.replace(
                        /(\d+)\s*(ml|mg|gm|g|mcg|tab|cap|drop|drops|syp|syrup)/gi,
                        '$1$2',
                    ),
                    strPacking.replace(
                        /(\d+)\s*(ml|mg|gm|g|mcg|tab|cap|drop|drops|syp|syrup)/gi,
                        '$1 $2',
                    ),
                ].filter(Boolean),
            ),
        );

        for (const form of possiblePackingForms) {
            const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleanedName = cleanedName.replace(new RegExp(escaped, 'ig'), ' ');
        }

        const normalizedCleaned = this.normalize(cleanedName);

        if (!normalizedCleaned) {
            return name;
        }

        return cleanedName.replace(/\s+/g, ' ').trim();
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

                const cleanedCsvName = this.removePackingFromName(csvName, packing);
                const normalizedCsvName = this.normalize(cleanedCsvName);
                const normalizedCsvCompany = this.normalize(csvCompany);

                let matchedProduct: string | null = null;
                let matchedCompany: string | null = null;
                let matchedId: number | null = null;
                let productScore: number | null = null;
                let companyScore: number | null = null;
                let uniqueVendors: string[] = [];

                const exactMatch = normalizedProducts.find(
                    (p) => p.normalizedName === normalizedCsvName,
                );

                if (exactMatch) {
                    matchedProduct = exactMatch.productName;
                    matchedCompany = exactMatch.company;
                    matchedId = exactMatch.id;
                    productScore = 0;
                    uniqueVendors = this.getUniqueVendors(
                        exactMatch.productName,
                        normalizedProducts,
                    );
                } else {
                    const productResults = productFuse.search(normalizedCsvName);

                    if (productResults.length > 0) {
                        const best = productResults[0];
                        matchedProduct = best.item.productName;
                        matchedCompany = best.item.company;
                        matchedId = best.item.id;
                        productScore = this.toDisplayScore(best.score ?? null);
                        uniqueVendors = this.getUniqueVendors(
                            best.item.productName,
                            normalizedProducts,
                        );
                    }
                }

                if (productScore !== null && productScore >= 0 && productScore <= 0.4) {
                    return {
                        SNo: sNo,
                        Particulars: csvName,
                        cleanedParticulars: cleanedCsvName,
                        Packing: packing,
                        Company: csvCompany,
                        matchedCompany,
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

                if (normalizedCsvCompany) {
                    const companyResults = companyFuse.search(normalizedCsvCompany);

                    if (companyResults.length > 0) {
                        const bestCompany = companyResults[0];
                        matchedCompany = bestCompany.item.company;
                        companyScore = this.toDisplayScore(bestCompany.score ?? null);
                    }
                }

                if (companyScore !== null && companyScore >= 0 && companyScore <= 0.3) {
                    return {
                        SNo: sNo,
                        Particulars: csvName,
                        cleanedParticulars: cleanedCsvName,
                        Packing: packing,
                        Company: csvCompany,
                        matchedCompany,
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
                        status: 'Company-to-company match',
                    };
                }

                return {
                    SNo: sNo,
                    Particulars: csvName,
                    cleanedParticulars: cleanedCsvName,
                    Packing: packing,
                    Company: csvCompany,
                    matchedCompany,
                    'Qty.': qty,
                    Free: free,
                    Rate: rate,
                    Amount: amount,
                    matchedProduct,
                    matchedId,
                    score: productScore,
                    companyScore,
                    decision: 'no',
                    uniqueVendors,
                    status: matchedProduct ? 'Weak product match only' : 'No match found',
                };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);

        return results;
    }
}
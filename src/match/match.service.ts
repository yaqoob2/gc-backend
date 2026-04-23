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

    private cleanText(value: any): string {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

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
            .replace(/(\d+)\s*[xX]\s*(\d+)/g, '$1x$2')
            .replace(/\s+/g, ' ')
            .replace(/[^a-z0-9 ]/g, '')
            .trim()
            .replace(/\s+/g, '');
    }

    toDisplayScore(rawScore: number | null): number | null {
        if (rawScore === null || rawScore === undefined) return null;
        return Number((rawScore * 10).toFixed(2));
    }

    private beautifyProductName(name: any, packing?: any): string {
        let cleaned = this.cleanText(name);
        const pack = this.cleanText(packing);

        if (!cleaned) return '';

        if (pack) {
            const escapedPack = pack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleaned = cleaned.replace(new RegExp(`\\s*${escapedPack}\\s*$`, 'i'), '').trim();

            const compactPack = pack.replace(/\s+/g, '');
            const escapedCompact = compactPack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleaned = cleaned.replace(new RegExp(`\\s*${escapedCompact}\\s*$`, 'i'), '').trim();
        }

        const trailingPatterns = [
            /\s+\d+\s*[xX]\s*\d+\s*$/i,
            /\s+\d+\s*(tab|tabs|tablet|tablets)\s*$/i,
            /\s+\d+\s*(cap|caps|capsule|capsules)\s*$/i,
            /\s+\d+\s*(ml|mg|gm|g|mcg)\s*$/i,
            /\s+[xX]?\s*\d+\s*(tab|tabs|cap|caps)\s*$/i,
            /\s+\d+\s*[-/]\s*\d+\s*$/i,
        ];

        for (const pattern of trailingPatterns) {
            cleaned = cleaned.replace(pattern, '').trim();
        }

        return cleaned;
    }

    private uniqueCleanStrings(values: any[]): string[] {
        return [...new Set(
            values
                .map((v) => this.cleanText(v))
                .filter((v) => v !== ''),
        )];
    }

    private getBestProductMatch(normalizedCsvName: string, normalizedProducts: any[]) {
        const exactMatch = normalizedProducts.find(
            (p) => p.normalizedName === normalizedCsvName,
        );

        if (exactMatch) {
            return {
                matchedProduct: exactMatch.productName,
                matchedCompany: exactMatch.company,
                matchedId: exactMatch.id,
                productScore: 0,
                exact: true,
            };
        }

        const productFuse = new Fuse(normalizedProducts, {
            keys: ['normalizedName'],
            threshold: 0.4,
            includeScore: true,
        });

        const productResults = productFuse.search(normalizedCsvName);

        if (productResults.length === 0) {
            return {
                matchedProduct: null,
                matchedCompany: null,
                matchedId: null,
                productScore: null,
                exact: false,
            };
        }

        const best = productResults[0];

        return {
            matchedProduct: best.item.productName,
            matchedCompany: best.item.company,
            matchedId: best.item.id,
            productScore: this.toDisplayScore(best.score ?? null),
            exact: false,
        };
    }

    private getBestCompanyMatch(normalizedCsvCompany: string, normalizedProducts: any[]) {
        if (!normalizedCsvCompany) {
            return {
                matchedCompany: null,
                companyScore: null,
            };
        }

        const companyFuse = new Fuse(normalizedProducts, {
            keys: ['normalizedCompany'],
            threshold: 0.3,
            includeScore: true,
        });

        const companyResults = companyFuse.search(normalizedCsvCompany);

        if (companyResults.length === 0) {
            return {
                matchedCompany: null,
                companyScore: null,
            };
        }

        const bestCompany = companyResults[0];

        return {
            matchedCompany: bestCompany.item.company,
            companyScore: this.toDisplayScore(bestCompany.score ?? null),
        };
    }

    private getRelatedProductRows(
        cleanedCsvName: string,
        csvCompany: string,
        normalizedProducts: any[],
    ) {
        const normalizedCsvName = this.normalize(cleanedCsvName);
        const normalizedCsvCompany = this.normalize(csvCompany);

        const fuse = new Fuse(normalizedProducts, {
            keys: ['normalizedName'],
            threshold: 0.35,
            includeScore: true,
        });

        const productCandidates = fuse
            .search(normalizedCsvName)
            .filter((r) => (r.score ?? 1) <= 0.35)
            .map((r) => r.item);

        const exactNameCandidates = normalizedProducts.filter(
            (p) => p.normalizedName === normalizedCsvName,
        );

        let merged = [...exactNameCandidates, ...productCandidates];

        if (normalizedCsvCompany) {
            merged = merged.filter((p) => {
                if (!p.normalizedCompany) return true;
                return p.normalizedCompany === normalizedCsvCompany || p.normalizedName === normalizedCsvName;
            });
        }

        const seen = new Set<number>();
        return merged.filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    }

    private getUniqueVendorsForMatch(
        cleanedCsvName: string,
        csvCompany: string,
        normalizedProducts: any[],
        matchedProduct: string | null,
    ): string[] {
        let candidateRows = this.getRelatedProductRows(
            cleanedCsvName,
            csvCompany,
            normalizedProducts,
        );

        if (candidateRows.length === 0 && matchedProduct) {
            const normalizedTarget = this.normalize(matchedProduct);
            candidateRows = normalizedProducts.filter(
                (p) => p.normalizedName === normalizedTarget,
            );
        }

        return this.uniqueCleanStrings(candidateRows.map((p) => p.vendorName));
    }

    async matchCsvRows(csvRows: any[]) {
        const products = await this.masterRepo.find();

        const normalizedProducts = products.map((p) => ({
            ...p,
            normalizedName: this.normalize(p.productName),
            normalizedCompany: this.normalize(p.company),
        }));

        const results = csvRows
            .map((row) => {
                const csvName =
                    row.Particulars || row.product_name || row.name || row.product || '';

                if (!csvName || String(csvName).trim() === '') {
                    return null;
                }

                const csvCompany = row.Company || row.company || '';
                const sNo = row.SNo ?? null;
                const packing = row.Packing ?? '';
                const qty = row['Qty.'] ?? row.Qty ?? '';
                const free = row.Free ?? '';
                const rate = row.Rate ?? '';
                const amount = row.Amount ?? '';

                const cleanedCsvName = this.beautifyProductName(csvName, packing);
                const normalizedCsvName = this.normalize(cleanedCsvName);
                const normalizedCsvCompany = this.normalize(csvCompany);

                let matchedProduct: string | null = null;
                let matchedCompany: string | null = null;
                let matchedId: number | null = null;
                let productScore: number | null = null;
                let companyScore: number | null = null;
                let uniqueVendors: string[] = [];

                const productMatch = this.getBestProductMatch(
                    normalizedCsvName,
                    normalizedProducts,
                );

                matchedProduct = productMatch.matchedProduct;
                matchedCompany = productMatch.matchedCompany;
                matchedId = productMatch.matchedId;
                productScore = productMatch.productScore;

                if (matchedProduct) {
                    uniqueVendors = this.getUniqueVendorsForMatch(
                        cleanedCsvName,
                        csvCompany,
                        normalizedProducts,
                        matchedProduct,
                    );
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
                        status: productMatch.exact ? 'Exact product match' : 'Product fuzzy match',
                    };
                }

                const companyMatch = this.getBestCompanyMatch(
                    normalizedCsvCompany,
                    normalizedProducts,
                );

                matchedCompany = companyMatch.matchedCompany;
                companyScore = companyMatch.companyScore;

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

    async buildVendorwiseResults(results: any[]) {
        const products = await this.masterRepo.find();
        const vendorwiseRows: any[] = [];

        for (const row of results) {
            if (!row.matchedProduct) continue;

            const normalizedMatchedProduct = this.normalize(row.matchedProduct);
            const normalizedMatchedCompany = this.normalize(row.matchedCompany || row.Company || '');

            let matchedMasterRows = products.filter(
                (p) => this.normalize(p.productName) === normalizedMatchedProduct,
            );

            if (normalizedMatchedCompany) {
                const companyFiltered = matchedMasterRows.filter(
                    (p) => this.normalize(p.company) === normalizedMatchedCompany,
                );

                if (companyFiltered.length > 0) {
                    matchedMasterRows = companyFiltered;
                }
            }

            const seenVendorProduct = new Set<string>();

            for (const masterRow of matchedMasterRows) {
                const dedupeKey = `${this.cleanText(masterRow.vendorName)}__${this.cleanText(masterRow.productName)}`;
                if (seenVendorProduct.has(dedupeKey)) continue;
                seenVendorProduct.add(dedupeKey);

                vendorwiseRows.push({
                    vendorName: masterRow.vendorName ?? null,
                    avgRate: masterRow.avgRate ?? null,
                    SNo: row.SNo,
                    Particulars: row.Particulars,
                    cleanedParticulars: row.cleanedParticulars,
                    Packing: row.Packing,
                    Company: row.Company,
                    matchedCompany: row.matchedCompany ?? masterRow.company ?? null,
                    'Qty.': row['Qty.'],
                    Free: row.Free,
                    Rate: row.Rate,
                    Amount: row.Amount,
                    matchedProduct: row.matchedProduct,
                    matchedId: row.matchedId,
                    score: row.score,
                    companyScore: row.companyScore,
                    decision: row.decision,
                    status: row.status,
                });
            }
        }

        return vendorwiseRows;
    }

    groupVendorwiseResults(vendorwiseRows: any[]) {
        const grouped: Record<string, any[]> = {};

        for (const row of vendorwiseRows) {
            const vendor = this.cleanText(row.vendorName) || 'Unknown Vendor';

            if (!grouped[vendor]) {
                grouped[vendor] = [];
            }

            grouped[vendor].push(row);
        }

        return grouped;
    }
}
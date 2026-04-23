import {
    Controller,
    Post,
    UploadedFile,
    UseInterceptors,
    BadRequestException,
    UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { MatchService } from './match.service';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import {
    ApiBody,
    ApiConsumes,
    ApiTags,
    ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('match')
@Controller('match')
export class MatchController {
    constructor(private readonly matchService: MatchService) { }

    @Post('upload')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard)
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
            required: ['file'],
        },
    })
    @UseInterceptors(
        FileInterceptor('file', {
            storage: diskStorage({
                destination: './uploads',
                filename: (req, file, cb) => {
                    cb(null, `${Date.now()}-${file.originalname}`);
                },
            }),
        }),
    )
    async uploadCsv(@UploadedFile() file: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('No file uploaded');
        }

        const fileName = file.originalname.toLowerCase();

        if (
            !fileName.endsWith('.csv') &&
            !fileName.endsWith('.xlsx') &&
            !fileName.endsWith('.xls')
        ) {
            throw new BadRequestException('Only CSV or Excel files are allowed');
        }

        const parsed = this.parseExcel(file.path);

        if (!parsed.rows.length) {
            fs.unlinkSync(file.path);
            throw new BadRequestException(
                'Could not find a valid header row. Expected a column like "Particulars".',
            );
        }

        const results = await this.matchService.matchCsvRows(parsed.rows);
        const vendorwiseResults = await this.matchService.buildVendorwiseResults(results);
        const vendorwiseGrouped = this.matchService.groupVendorwiseResults(vendorwiseResults);

        fs.unlinkSync(file.path);

        return {
            documentHeader: parsed.documentHeader,
            totalRows: parsed.rows.length,
            matchedRows: results.filter((r) => r.matchedProduct).length,
            unmatchedRows: results.filter((r) => !r.matchedProduct).length,
            results,
            vendorwiseResults,
            vendorwiseGrouped,
        };
    }

    parseExcel(filePath: string): {
        documentHeader: {
            title: string | null;
            lines: string[];
            rawRows: string[][];
        };
        rows: any[];
    } {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            blankrows: false,
            defval: '',
        });

        const headerIndex = rows.findIndex(
            (row) =>
                Array.isArray(row) &&
                row.some(
                    (cell) =>
                        String(cell).trim().toLowerCase() === 'particulars',
                ),
        );

        if (headerIndex === -1) {
            return {
                documentHeader: {
                    title: null,
                    lines: [],
                    rawRows: [],
                },
                rows: [],
            };
        }

        const headerRows = rows.slice(0, headerIndex);

        const cleanedHeaderRows: string[][] = headerRows
            .map((row) =>
                (row || [])
                    .map((cell) => String(cell ?? '').trim())
                    .filter((cell) => cell !== ''),
            )
            .filter((row) => row.length > 0);

        const headerLines: string[] = cleanedHeaderRows.map((row) => row.join(' | '));

        const title =
            cleanedHeaderRows.length > 0 && cleanedHeaderRows[0].length > 0
                ? cleanedHeaderRows[0][0]
                : null;

        const headers = rows[headerIndex].map((cell) => String(cell).trim());
        const dataRows = rows.slice(headerIndex + 1);

        const formatted = dataRows
            .filter(
                (row) =>
                    Array.isArray(row) &&
                    row.some(
                        (cell) =>
                            cell !== undefined &&
                            cell !== null &&
                            String(cell).trim() !== '',
                    ),
            )
            .map((row) => {
                const obj: any = {};
                headers.forEach((header, index) => {
                    obj[header] = row[index];
                });
                return obj;
            });

        return {
            documentHeader: {
                title,
                lines: headerLines,
                rawRows: cleanedHeaderRows,
            },
            rows: formatted,
        };
    }
}
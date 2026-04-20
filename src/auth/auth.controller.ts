import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    @Post('login')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                username: { type: 'string', example: 'admin' },
                password: { type: 'string', example: 'admin123' },
            },
            required: ['username', 'password'],
        },
    })
    async login(@Body() body: { username: string; password: string }) {
        if (!body.username || !body.password) {
            throw new BadRequestException('Username and password are required');
        }

        return this.authService.login(body.username, body.password);
    }
}